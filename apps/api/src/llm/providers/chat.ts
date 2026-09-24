// Shared OpenAI-compatible Chat Completions mapper used by the OpenAI and OpenRouter providers.
// AMENDMENTS A1 (thinking dropped outbound), A4 (reasoning_effort), A5 (usage), A7 (mapping).
import OpenAI from 'openai';
import { LLM_REQUEST_TIMEOUT_MS, ceilMicro, MICRO, priceUsage, type Effort, type ModelInfo, type StopReason } from '@vantra/shared';
import type { LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmToolDef } from '../../core/interfaces.js';
import { errorMessage } from '../../lib/errors.js';
import { isRetryableStatus, LlmCallError } from '../errors.js';
import { toStrictSchema } from '../schema.js';
import { requestTimeoutMs } from '../timeout.js';

export const CHAT_REQUEST_TIMEOUT_MS = LLM_REQUEST_TIMEOUT_MS;

type ChatProviderName = 'openai' | 'openrouter';
type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
type FinishReason = ChatCompletion['choices'][number]['finish_reason'];

// `usage.include` is an OpenRouter extension (A5); the SDK forwards unknown params untouched.
export interface ChatParams extends OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  usage?: { include: boolean };
}

export interface ChatProviderOpts {
  name: ChatProviderName;
  client: OpenAI;
  costFromUsage: boolean;  // usage.cost (USD) is authoritative when present
}

export function createChatProvider(opts: ChatProviderOpts): LlmProvider {
  return {
    name: opts.name,
    async complete(req, model) {
      // The dialect is read off the model, so a model can never be sent in the other provider's
      // shape. The router already routes by `model.provider`; this makes a drift there loud.
      if (model.provider !== opts.name) {
        throw new LlmCallError(opts.name, `model "${model.id}" is a ${model.provider} model and cannot be sent to ${opts.name}`, { retryable: false });
      }
      const params = buildChatRequest(req, model);
      let completion: ChatCompletion;
      try {
        completion = await opts.client.chat.completions.create(params, { signal: req.signal, timeout: requestTimeoutMs(req.remainingMs) });
      } catch (e) {
        throw toCallError(opts.name, e);
      }
      return mapChatResponse(completion, model, { costFromUsage: opts.costFromUsage, providerName: opts.name });
    },
  };
}

// The two dialects differ on the wire and the difference costs real money, so it is taken from
// `model.provider` rather than from a flag a caller could get wrong.
//
// OpenAI (reasoning models): `max_tokens` is rejected outright — the cap is `max_completion_tokens`.
// `parallel_tool_calls` and `reasoning_effort` are first-class.
//
// OpenRouter: verified against the live `GET /api/v1/models` catalogue on 2026-09-18 — every model
// VANTRA serves (deepseek/deepseek-chat-v3.1, qwen/qwen3-235b-a22b-2507, moonshotai/kimi-k2)
// advertises `max_tokens`, `tools` and `tool_choice` in `supported_parameters`, and NONE of them
// advertises `max_completion_tokens` or `parallel_tool_calls`. OpenRouter drops parameters the
// upstream does not support, so sending the OpenAI spelling of the output cap would leave the
// generation UNCAPPED and let one step drain an agent's treasury. `max_tokens` is the only spelling
// proven to bind there.
export function buildChatRequest(req: LlmRequest, model: ModelInfo): ChatParams {
  const openrouter = model.provider === 'openrouter';
  const params: ChatParams = {
    model: model.id,
    messages: toChatMessages(req.system, req.messages),
    ...(openrouter ? { max_tokens: req.maxTokens } : { max_completion_tokens: req.maxTokens }),
  };
  if (req.tools.length > 0) {
    params.tools = [...req.tools].sort((a, b) => a.name.localeCompare(b.name)).map(toTool);
    if (!openrouter) params.parallel_tool_calls = true;
    if (req.toolChoice === 'none') params.tool_choice = 'none';
  }
  if (model.supportsEffort && req.effort) params.reasoning_effort = toReasoningEffort(req.effort);
  if (openrouter) params.usage = { include: true };
  return params;
}

// A4: low→low, medium→medium, high/xhigh/max→high.
export function toReasoningEffort(effort: Effort): 'low' | 'medium' | 'high' {
  return effort === 'low' || effort === 'medium' ? effort : 'high';
}

function toTool(def: LlmToolDef): OpenAI.Chat.Completions.ChatCompletionFunctionTool {
  return { type: 'function', function: { name: def.name, description: def.description, parameters: toStrictSchema(def.inputSchema), strict: true } };
}

function toChatMessages(system: string, messages: LlmMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') out.push(assistantMessage(m.content));
    else out.push(...userMessages(m.content));
  }
  return out;
}

function assistantMessage(content: LlmContent[]): ChatMessage {
  const text = joinText(content);
  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
  for (const c of content) {
    if (c.type === 'tool_use') toolCalls.push({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } });
  }
  const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
    role: 'assistant',
    content: text.length > 0 ? text : toolCalls.length > 0 ? null : '',
  };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  return msg;
}

// Each tool_result becomes its own `tool` message right after the assistant turn; any text in the
// same user turn (e.g. the round-cap reminder) follows as a user message.
function userMessages(content: LlmContent[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const c of content) {
    if (c.type === 'tool_result') out.push({ role: 'tool', tool_call_id: c.toolUseId, content: c.isError ? `ERROR: ${c.content}` : c.content });
  }
  const text = joinText(content);
  if (text.length > 0) out.push({ role: 'user', content: text });
  return out;
}

const joinText = (content: LlmContent[]): string =>
  content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n\n');

// OpenRouter reports upstream failures as HTTP 200 with a top-level `error` object and no `choices`
// (rate limits, credit exhaustion, an upstream provider outage). The SDK does not raise on those, so
// without this the step would record a bare "provider error" with the real reason thrown away — and
// a 429 that should have been retried would not be. Surfaced as a normal call error instead.
interface ChatErrorBody { error?: { message?: unknown; code?: unknown } }

function throwIfErrorBody(name: ChatProviderName, completion: ChatCompletion): void {
  const err = (completion as ChatCompletion & ChatErrorBody).error;
  const hasChoice = Array.isArray(completion.choices) && completion.choices.length > 0;
  if (!err && hasChoice) return;
  const status = typeof err?.code === 'number' ? err.code : undefined;
  const detail = typeof err?.message === 'string' && err.message.length > 0
    ? err.message
    : 'response carried no choices';
  throw new LlmCallError(name, status === undefined ? detail : `HTTP ${status}: ${detail}`, {
    ...(status === undefined ? {} : { status }),
    retryable: isRetryableStatus(status),
  });
}

export function mapChatResponse(
  completion: ChatCompletion,
  model: ModelInfo,
  opts: { costFromUsage: boolean; providerName?: ChatProviderName },
): LlmResponse {
  throwIfErrorBody(opts.providerName ?? (model.provider === 'openrouter' ? 'openrouter' : 'openai'), completion);
  const choice = completion.choices[0];
  const content: LlmContent[] = [];
  let stopReason: StopReason = 'error';
  let stopDetails: LlmResponse['stopDetails'];
  if (choice) {
    const msg = choice.message;
    if (msg.content) content.push({ type: 'text', text: msg.content });
    let toolCalls = 0;
    for (const call of msg.tool_calls ?? []) {
      if (call.type !== 'function') continue;
      toolCalls++;
      content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) });
    }
    if (msg.refusal) {
      content.push({ type: 'text', text: msg.refusal });
      stopReason = 'refusal';
      stopDetails = { category: null, explanation: msg.refusal };
    } else {
      stopReason = toolCalls > 0 && choice.finish_reason === 'stop' ? 'tool_use' : mapFinishReason(choice.finish_reason);
      if (choice.finish_reason === 'content_filter') stopDetails = { category: 'content_filter' };
    }
  }

  const usage = completion.usage;
  const promptTokens = usage?.prompt_tokens ?? 0;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const tokens = {
    inputTokens: Math.max(0, promptTokens - cachedTokens),
    cacheReadTokens: cachedTokens,
    cacheWriteTokens: 0,
    outputTokens: usage?.completion_tokens ?? 0,
  };
  const reportedCost = (usage as { cost?: unknown } | undefined)?.cost;
  const costMicro = opts.costFromUsage && typeof reportedCost === 'number' && Number.isFinite(reportedCost)
    ? ceilMicro(reportedCost * MICRO)
    : priceUsage(model, tokens);

  const res: LlmResponse = { content, stopReason, usage: { ...tokens, costMicro }, model: completion.model, raw: completion };
  if (stopDetails) res.stopDetails = stopDetails;
  return res;
}

const FINISH_REASONS: Record<NonNullable<FinishReason>, StopReason> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
};

function mapFinishReason(reason: FinishReason | null): StopReason {
  return (reason && FINISH_REASONS[reason]) ?? 'error';
}

// Arguments are a JSON string; unparseable arguments are passed through so the registry reports them.
function parseArguments(args: string): unknown {
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}

function toCallError(name: ChatProviderName, e: unknown): LlmCallError {
  if (e instanceof OpenAI.APIUserAbortError) return new LlmCallError(name, 'request aborted', { retryable: false, cause: e });
  if (e instanceof OpenAI.APIConnectionError) return new LlmCallError(name, `network error: ${e.message}`, { retryable: true, cause: e });
  if (e instanceof OpenAI.APIError) {
    return new LlmCallError(name, `HTTP ${e.status}: ${e.message}`, { status: e.status, retryable: isRetryableStatus(e.status), cause: e });
  }
  return new LlmCallError(name, errorMessage(e), { retryable: false, cause: e });
}

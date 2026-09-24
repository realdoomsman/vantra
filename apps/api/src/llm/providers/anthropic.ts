// Anthropic Messages API provider. SPEC §6; AMENDMENTS A1 (thinking blocks 1:1), A3 (stop details),
// A5 (usage → cost), A6 (request shape, caching, retries owned by the router).
import Anthropic from '@anthropic-ai/sdk';
import { LLM_REQUEST_TIMEOUT_MS, priceUsage, type ModelInfo, type StopReason } from '@vantra/shared';
import type { LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmToolDef } from '../../core/interfaces.js';
import { errorMessage } from '../../lib/errors.js';
import { isRetryableStatus, LlmCallError } from '../errors.js';
import { requestTimeoutMs } from '../timeout.js';

// A6's ceiling: the per-request timeout is min(remaining step budget, this).
export const ANTHROPIC_REQUEST_TIMEOUT_MS = LLM_REQUEST_TIMEOUT_MS;
const BUDGET_THINKING_MIN = 1_024;
const BUDGET_THINKING_MAX = 16_000;

export type AnthropicParams = Anthropic.MessageCreateParamsNonStreaming;

export interface AnthropicProviderOpts { apiKey: string; client?: Anthropic }

export function createAnthropicProvider(opts: AnthropicProviderOpts): LlmProvider {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 0 });
  return {
    name: 'anthropic',
    async complete(req, model) {
      const params = buildAnthropicRequest(req, model);
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(params, { signal: req.signal, timeout: requestTimeoutMs(req.remainingMs) });
      } catch (e) {
        throw toCallError(e);
      }
      return mapAnthropicResponse(message, model);
    },
  };
}

export function buildAnthropicRequest(req: LlmRequest, model: ModelInfo): AnthropicParams {
  // Two reasons, both of which are 400s from the API rather than anything we could recover from:
  // `messages` must be non-empty, and the explicit 1h breakpoint below must not be the LAST cacheable
  // block while top-level automatic caching is asking for the 5m default — mismatched TTLs on the
  // same block are rejected. A non-empty `messages` array guarantees the system block is never last.
  if (req.messages.length === 0) throw new Error('anthropic request needs at least one message');
  const params: AnthropicParams = {
    model: model.id,
    max_tokens: req.maxTokens,
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: req.messages.map(toMessageParam),
    cache_control: { type: 'ephemeral' },
  };
  if (req.tools.length > 0) {
    params.tools = [...req.tools].sort((a, b) => a.name.localeCompare(b.name)).map(toTool);
    if (req.toolChoice === 'none') params.tool_choice = { type: 'none' };
  }
  const thinking = thinkingParam(model, req.maxTokens);
  if (thinking) params.thinking = thinking;
  if (model.supportsEffort && req.effort) params.output_config = { effort: req.effort };
  return params;
}

function thinkingParam(model: ModelInfo, maxTokens: number): Anthropic.ThinkingConfigParam | null {
  if (model.thinking === 'adaptive') return { type: 'adaptive' };
  if (model.thinking === 'budget' && maxTokens > BUDGET_THINKING_MIN) {
    const budget = Math.min(BUDGET_THINKING_MAX, Math.max(BUDGET_THINKING_MIN, Math.floor(maxTokens / 2)));
    return { type: 'enabled', budget_tokens: budget };
  }
  return null;
}

function toTool(def: LlmToolDef): Anthropic.Tool {
  return {
    name: def.name,
    description: def.description,
    input_schema: { ...def.inputSchema, type: 'object' },
    strict: true,
  };
}

function toMessageParam(m: LlmMessage): Anthropic.MessageParam {
  return { role: m.role, content: m.content.map(toBlockParam) };
}

// The Messages API rejects a text block that is empty or whitespace-only ("text content blocks must
// contain non-whitespace text") and applies the same rule to a string `tool_result.content`. No tool
// currently returns an empty body, but one that did would 400 the whole turn — including every earlier
// round in it — so the block carries an explicit marker instead. Never silently dropped: the model is
// told the tool produced nothing.
const EMPTY_BLOCK_TEXT = '(empty)';
const nonEmpty = (s: string): string => (s.trim().length > 0 ? s : EMPTY_BLOCK_TEXT);

function toBlockParam(c: LlmContent): Anthropic.ContentBlockParam {
  switch (c.type) {
    case 'text': return { type: 'text', text: nonEmpty(c.text) };
    case 'tool_use': return { type: 'tool_use', id: c.id, name: c.name, input: c.input };
    case 'tool_result': return { type: 'tool_result', tool_use_id: c.toolUseId, content: nonEmpty(c.content), ...(c.isError ? { is_error: true } : {}) };
    case 'thinking': return { type: 'thinking', thinking: c.thinking, signature: c.signature };
    case 'redacted_thinking': return { type: 'redacted_thinking', data: c.data };
  }
}

export function mapAnthropicResponse(message: Anthropic.Message, model: ModelInfo): LlmResponse {
  const content: LlmContent[] = [];
  for (const block of message.content) {
    switch (block.type) {
      case 'text': content.push({ type: 'text', text: block.text }); break;
      case 'tool_use': content.push({ type: 'tool_use', id: block.id, name: block.name, input: parseToolInput(block.input) }); break;
      case 'thinking': content.push({ type: 'thinking', thinking: block.thinking, signature: block.signature }); break;
      case 'redacted_thinking': content.push({ type: 'redacted_thinking', data: block.data }); break;
      default: break;   // server-tool blocks are never requested
    }
  }
  const tokens = {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
  // buildAnthropicRequest marks the system prompt with `ttl: '1h'`, and a 1-hour cache write is
  // billed at 2× base input where a 5-minute write is 1.25×. `usage.cache_creation` carries the
  // split; pricing the whole write at the 5m rate would silently under-charge every step that
  // (re)writes the system prefix. When the API omits the breakdown there is nothing to attribute,
  // so the write is priced at the 5m rate — see the golden test in test/llm/cost-audit.test.ts.
  const cacheWrite1hTokens = message.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const res: LlmResponse = {
    content,
    stopReason: mapStopReason(message.stop_reason),
    usage: { ...tokens, costMicro: priceUsage(model, { ...tokens, cacheWrite1hTokens }) },
    model: message.model,
    raw: message,
  };
  if (message.stop_details) {
    res.stopDetails = {
      category: message.stop_details.category,
      ...(message.stop_details.explanation ? { explanation: message.stop_details.explanation } : {}),
    };
  }
  return res;
}

const STOP_REASONS: Record<Anthropic.StopReason, StopReason> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
  pause_turn: 'pause_turn',
  stop_sequence: 'stop_sequence',
  // NOT 'max_tokens'. That one means the reply hit the output cap and is cured by raising it;
  // this one means the CONVERSATION no longer fits the model's input window, where raising the
  // output cap only makes the next request bigger. step.ts aborts on it instead of retrying.
  model_context_window_exceeded: 'context_window',
};

function mapStopReason(reason: Anthropic.StopReason | null): StopReason {
  return (reason && STOP_REASONS[reason]) ?? 'error';
}

// Tool inputs arrive parsed; a string body is parsed as JSON and left as-is when it is not JSON
// so the registry's validation reports it instead of a string match here (A6).
function parseToolInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function toCallError(e: unknown): LlmCallError {
  if (e instanceof Anthropic.APIUserAbortError) return new LlmCallError('anthropic', 'request aborted', { retryable: false, cause: e });
  if (e instanceof Anthropic.APIConnectionError) return new LlmCallError('anthropic', `network error: ${e.message}`, { retryable: true, cause: e });
  if (e instanceof Anthropic.APIError) {
    return new LlmCallError('anthropic', `HTTP ${e.status}: ${e.message}`, { status: e.status, retryable: isRetryableStatus(e.status), cause: e });
  }
  return new LlmCallError('anthropic', errorMessage(e), { retryable: false, cause: e });
}

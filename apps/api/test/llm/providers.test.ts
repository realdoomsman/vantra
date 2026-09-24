// Provider wiring against stubbed SDK clients: per-request signal/timeout and error normalisation.
// No network: `client` is injected, so nothing here can reach a real API.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CATALOG, LLM_REQUEST_TIMEOUT_MIN_MS, LLM_REQUEST_TIMEOUT_MS } from '@vantra/shared';
import { LlmCallError } from '../../src/llm/errors.js';
import { ANTHROPIC_REQUEST_TIMEOUT_MS, createAnthropicProvider } from '../../src/llm/providers/anthropic.js';
import { CHAT_REQUEST_TIMEOUT_MS } from '../../src/llm/providers/chat.js';
import { createOpenAiProvider } from '../../src/llm/providers/openai.js';
import { createOpenRouterProvider, OPENROUTER_BASE_URL } from '../../src/llm/providers/openrouter.js';
import { makeRequest } from './helpers.js';

const sonnet = DEFAULT_CATALOG.find((m) => m.id === 'claude-sonnet-5')!;
const nano = DEFAULT_CATALOG.find((m) => m.id === 'gpt-5-nano')!;
const kimi = DEFAULT_CATALOG.find((m) => m.id === 'moonshotai/kimi-k2')!;

const anthropicClient = (create: (...args: unknown[]) => unknown) => ({ messages: { create } }) as unknown as Anthropic;
const openaiClient = (create: (...args: unknown[]) => unknown) => ({ chat: { completions: { create } } }) as unknown as OpenAI;

const ANTHROPIC_MESSAGE = {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'end_turn', stop_sequence: null,
  content: [{ type: 'text', text: 'ok' }],
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
};
const CHAT_COMPLETION = {
  id: 'c1', object: 'chat.completion', created: 0, model: 'gpt-5-nano',
  choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'ok', refusal: null } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

describe('anthropic provider', () => {
  it('passes the step signal and a bounded timeout with every request', async () => {
    const create = vi.fn(async (_params: unknown, _opts: unknown) => ANTHROPIC_MESSAGE);
    const signal = new AbortController().signal;
    const provider = createAnthropicProvider({ apiKey: 'sk-test', client: anthropicClient(create) });

    const res = await provider.complete(makeRequest({ model: sonnet.id, signal }), sonnet);
    expect(res.usage.costMicro).toBeGreaterThan(0);
    expect(create.mock.calls[0]![1]).toEqual({ signal, timeout: ANTHROPIC_REQUEST_TIMEOUT_MS });
    expect(ANTHROPIC_REQUEST_TIMEOUT_MS).toBe(300_000);
  });

  // A6: `timeout: min(remainingStepMs, 300000)`, floored so a nearly-exhausted step still sends a
  // timeout the SDK accepts rather than a zero it rejects outright.
  it('bounds the request by the remaining step budget', async () => {
    const create = vi.fn(async (_params: unknown, _opts: unknown) => ANTHROPIC_MESSAGE);
    const provider = createAnthropicProvider({ apiKey: 'sk-test', client: anthropicClient(create) });

    await provider.complete(makeRequest({ model: sonnet.id, remainingMs: 45_000 }), sonnet);
    expect(create.mock.calls[0]![1]).toMatchObject({ timeout: 45_000 });

    await provider.complete(makeRequest({ model: sonnet.id, remainingMs: 900_000 }), sonnet);
    expect(create.mock.calls[1]![1]).toMatchObject({ timeout: LLM_REQUEST_TIMEOUT_MS });

    await provider.complete(makeRequest({ model: sonnet.id, remainingMs: -5 }), sonnet);
    expect(create.mock.calls[2]![1]).toMatchObject({ timeout: LLM_REQUEST_TIMEOUT_MIN_MS });
  });

  it.each([
    ['rate limit', new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers()), true, 429],
    ['server error', new Anthropic.InternalServerError(503, undefined, 'upstream', new Headers()), true, 503],
    ['bad request', new Anthropic.BadRequestError(400, undefined, 'nope', new Headers()), false, 400],
    ['network', new Anthropic.APIConnectionError({ message: 'socket hang up' }), true, undefined],
    ['abort', new Anthropic.APIUserAbortError(), false, undefined],
    ['unknown', new TypeError('boom'), false, undefined],
  ])('normalises a %s failure for the router', async (_label, thrown, retryable, status) => {
    const provider = createAnthropicProvider({ apiKey: 'sk-test', client: anthropicClient(async () => { throw thrown; }) });
    const error = await provider.complete(makeRequest({ model: sonnet.id }), sonnet).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmCallError);
    expect(error).toMatchObject({ provider: 'anthropic', retryable, status });
  });
});

describe('chat providers', () => {
  it('sends openai requests with the step signal and no usage accounting', async () => {
    const create = vi.fn(async (_params: unknown, _opts: unknown) => CHAT_COMPLETION);
    const signal = new AbortController().signal;
    const provider = createOpenAiProvider({ apiKey: 'sk-test', client: openaiClient(create) });

    await provider.complete(makeRequest({ model: nano.id, signal }), nano);
    expect(create.mock.calls[0]![1]).toEqual({ signal, timeout: CHAT_REQUEST_TIMEOUT_MS });
    expect(create.mock.calls[0]![0]).not.toHaveProperty('usage');
  });

  it('sends openrouter requests with usage accounting and prices from the reported cost', async () => {
    const create = vi.fn(async (_params: unknown, _opts: unknown) => ({ ...CHAT_COMPLETION, model: kimi.id, usage: { ...CHAT_COMPLETION.usage, cost: 0.001 } }));
    const provider = createOpenRouterProvider({ apiKey: 'or-test', client: openaiClient(create) });

    const res = await provider.complete(makeRequest({ model: kimi.id }), kimi);
    expect(create.mock.calls[0]![0]).toMatchObject({ usage: { include: true } });
    expect(res.usage.costMicro).toBe(1000);
    expect(OPENROUTER_BASE_URL).toBe('https://openrouter.ai/api/v1');
  });

  it('normalises chat failures with the provider name that raised them', async () => {
    const provider = createOpenAiProvider({ apiKey: 'sk-test', client: openaiClient(async () => { throw new OpenAI.InternalServerError(500, undefined, 'boom', new Headers()); }) });
    const error = await provider.complete(makeRequest({ model: nano.id }), nano).catch((e: unknown) => e);
    expect(error).toMatchObject({ provider: 'openai', retryable: true, status: 500 });
  });

  // OpenRouter reports upstream failures as HTTP 200 with a top-level `error` and no `choices`.
  // The SDK does not raise on those. Left unhandled the step records a bare "provider error" with
  // the real reason discarded, and a 429 that should have been retried is not.
  it('raises the OpenRouter 200-with-error body instead of swallowing it', async () => {
    const provider = createOpenRouterProvider({
      apiKey: 'or-test',
      client: openaiClient(async () => ({ id: 'c1', object: 'chat.completion', created: 0, model: kimi.id, choices: [], error: { code: 429, message: 'upstream rate-limited' } })),
    });
    const error = await provider.complete(makeRequest({ model: kimi.id }), kimi).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmCallError);
    expect(error).toMatchObject({ provider: 'openrouter', status: 429, retryable: true });
    expect((error as LlmCallError).message).toContain('upstream rate-limited');
  });

  it('raises a choice-less 200 rather than billing an empty turn at zero', async () => {
    const provider = createOpenRouterProvider({
      apiKey: 'or-test',
      client: openaiClient(async () => ({ id: 'c1', object: 'chat.completion', created: 0, model: kimi.id, choices: [] })),
    });
    const error = await provider.complete(makeRequest({ model: kimi.id }), kimi).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmCallError);
    expect(error).toMatchObject({ provider: 'openrouter', retryable: false });
    expect((error as LlmCallError).message).toContain('no choices');
  });

  // The dialect is chosen from `model.provider`; a model sent to the wrong provider would be built
  // in the wrong shape (wrong output-cap spelling above all). Loud, not silent.
  it('refuses to send a model to the provider it does not belong to', async () => {
    const create = vi.fn();
    const provider = createOpenAiProvider({ apiKey: 'sk-test', client: openaiClient(create) });
    const error = await provider.complete(makeRequest({ model: kimi.id }), kimi).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmCallError);
    expect((error as LlmCallError).message).toMatch(/openrouter model and cannot be sent to openai/);
    expect(create).not.toHaveBeenCalled();
  });
});

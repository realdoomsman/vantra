// What the SDK ACTUALLY puts on the wire.
//
// wire-format.test.ts pins the object buildAnthropicRequest / buildChatRequest return. That is one
// step short of the truth: between that object and the HTTP request sits the SDK, and a field it
// does not know about (`output_config`, top-level `cache_control`, `strict` on a tool, OpenRouter's
// `usage`) could be dropped in serialization and nobody would find out until the first real call
// came back wrong — or, worse, came back fine and uncapped.
//
// So these tests construct the REAL SDK clients with a fake `fetch` and assert the exact JSON body
// and the headers. Nothing reaches the network: `fetch` is replaced, not mocked at a higher layer.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '@vantra/shared';
import { createAnthropicProvider } from '../../src/llm/providers/anthropic.js';
import { createOpenAiProvider } from '../../src/llm/providers/openai.js';
import { createOpenRouterProvider, OPENROUTER_BASE_URL } from '../../src/llm/providers/openrouter.js';
import { makeRequest } from './helpers.js';

const opus = DEFAULT_CATALOG.find((m) => m.id === 'claude-opus-5')!;
const haiku = DEFAULT_CATALOG.find((m) => m.id === 'claude-haiku-4-5')!;
const nano = DEFAULT_CATALOG.find((m) => m.id === 'gpt-5-nano')!;
const kimi = DEFAULT_CATALOG.find((m) => m.id === 'moonshotai/kimi-k2')!;

interface Captured { url: string; headers: Record<string, string>; body: Record<string, unknown> }

// A `fetch` that records the request and answers with a minimal valid response for that API.
function capturing(reply: unknown): { calls: Captured[]; fetch: typeof fetch } {
  const calls: Captured[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      headers,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch: impl as unknown as typeof fetch };
}

const ANTHROPIC_REPLY = {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
  content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
};
const CHAT_REPLY = {
  id: 'c1', object: 'chat.completion', created: 0, model: 'gpt-5-nano',
  choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'ok', refusal: null } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

describe('anthropic: the bytes the SDK sends', () => {
  const send = async (model = opus) => {
    const { calls, fetch } = capturing(ANTHROPIC_REPLY);
    const provider = createAnthropicProvider({ apiKey: 'sk-ant-test', client: new Anthropic({ apiKey: 'sk-ant-test', maxRetries: 0, fetch }) });
    await provider.complete(makeRequest({ model: model.id, effort: 'high' }), model);
    return calls[0]!;
  };

  it('posts to /v1/messages with the api key and the version header', async () => {
    const call = await send();
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers['x-api-key']).toBe('sk-ant-test');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect(call.headers['content-type']).toContain('application/json');
  });

  // These four are the ones an SDK could plausibly swallow. If any is missing from the serialized
  // body, the first real call silently loses caching, effort, thinking or strict schemas.
  it('keeps output_config.effort, adaptive thinking, both cache breakpoints and tool strict', async () => {
    const call = await send();
    expect(call.body['output_config']).toEqual({ effort: 'high' });
    expect(call.body['thinking']).toEqual({ type: 'adaptive' });
    expect(call.body['cache_control']).toEqual({ type: 'ephemeral' });
    expect(call.body['system']).toEqual([{ type: 'text', text: expect.any(String), cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    const tools = call.body['tools'] as { name: string; strict: boolean; input_schema: Record<string, unknown> }[];
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.strict).toBe(true);
      expect(tool.input_schema['additionalProperties']).toBe(false);
      expect(Array.isArray(tool.input_schema['required'])).toBe(true);
    }
  });

  it('never streams and never sends a budget_tokens thinking config', async () => {
    const call = await send();
    expect(call.body['stream']).toBeUndefined();
    expect(JSON.stringify(call.body)).not.toContain('budget_tokens');
    expect(call.body['max_tokens']).toBe(16_000);
  });

  // The one parameter combination that is a guaranteed 400 on the first real call.
  it('sends claude-haiku-4-5 neither adaptive thinking nor effort', async () => {
    const call = await send(haiku);
    expect(call.body['thinking']).toBeUndefined();
    expect(call.body['output_config']).toBeUndefined();
    expect(call.body['model']).toBe('claude-haiku-4-5');
  });
});

describe('chat providers: the bytes the SDK sends', () => {
  it('posts openai with max_completion_tokens, parallel tool calls and strict functions', async () => {
    const { calls, fetch } = capturing(CHAT_REPLY);
    const provider = createOpenAiProvider({ apiKey: 'sk-test', client: new OpenAI({ apiKey: 'sk-test', maxRetries: 0, fetch }) });
    await provider.complete(makeRequest({ model: nano.id, effort: 'high' }), nano);

    const call = calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.headers['authorization']).toBe('Bearer sk-test');
    expect(call.body['max_completion_tokens']).toBe(16_000);
    expect(call.body['max_tokens']).toBeUndefined();
    expect(call.body['parallel_tool_calls']).toBe(true);
    expect(call.body['reasoning_effort']).toBe('high');
    expect(call.body['usage']).toBeUndefined();
    for (const tool of call.body['tools'] as { function: { strict: boolean } }[]) expect(tool.function.strict).toBe(true);
  });

  // `usage: {include: true}` is not in the OpenAI SDK's own parameter type — this is the proof the
  // SDK forwards it instead of stripping it. Without it OpenRouter reports no billed cost and every
  // completion falls back to catalog pricing.
  it('posts openrouter with max_tokens, the usage extension and no parallel_tool_calls', async () => {
    const { calls, fetch } = capturing({ ...CHAT_REPLY, model: kimi.id, usage: { ...CHAT_REPLY.usage, cost: 0.002 } });
    const provider = createOpenRouterProvider({ apiKey: 'sk-or-test', client: new OpenAI({ apiKey: 'sk-or-test', baseURL: OPENROUTER_BASE_URL, maxRetries: 0, defaultHeaders: { 'X-Title': 'VANTRA' }, fetch }) });
    const res = await provider.complete(makeRequest({ model: kimi.id, effort: 'high' }), kimi);

    const call = calls[0]!;
    expect(call.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    expect(call.headers['authorization']).toBe('Bearer sk-or-test');
    expect(call.headers['x-title']).toBe('VANTRA');
    expect(call.body['max_tokens']).toBe(16_000);
    expect(call.body['max_completion_tokens']).toBeUndefined();
    expect(call.body['parallel_tool_calls']).toBeUndefined();
    expect(call.body['reasoning_effort']).toBeUndefined();   // no openrouter model advertises it
    expect(call.body['usage']).toEqual({ include: true });
    expect(res.usage.costMicro).toBe(2_000);                 // priced from the reported usage.cost
  });
});

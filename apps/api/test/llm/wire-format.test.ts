// GOLDEN request bodies. Every byte here is what actually goes on the wire to a real API the first
// time a key is added, so these assertions are deep-equal against literals rather than toMatchObject:
// a field that appears, disappears or changes shape has to be written down here by hand.
//
// The per-model tables below are the point of the file. A parameter a model does not accept is a 400
// on the very first real call, and the two that matter today are:
//   · claude-haiku-4-5 rejects BOTH `thinking: {type:'adaptive'}` and `output_config.effort`.
//   · every OpenRouter model in the catalog is passed through to an upstream that has no OpenAI-style
//     reasoning control, so `reasoning_effort` must not be sent.
// COVERAGE is asserted against DEFAULT_CATALOG, so adding a model to the catalog fails this file
// until its exact body is written down.
import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG, type ModelInfo } from '@vantra/shared';
import type { LlmToolDef } from '../../src/core/interfaces.js';
import { ENV_ADDABLE_MODELS } from '../../src/llm/catalog.js';
import { buildAnthropicRequest, type AnthropicParams } from '../../src/llm/providers/anthropic.js';
import { buildChatRequest, type ChatParams } from '../../src/llm/providers/chat.js';
import { makeRequest } from './helpers.js';

// Two tools, deliberately out of alphabetical order, one all-required and one with an optional
// integer and an optional enum, so both strict dialects are pinned exactly.
const TOOLS: LlmToolDef[] = [
  {
    name: 'write_note',
    description: 'Write a note.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note body.' },
        pin: { type: 'integer', description: 'Slot to pin it to.' },
        kind: { type: 'string', enum: ['idea', 'todo'], description: 'Note kind.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'ping',
    description: 'Ping a host.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'Hostname.' } },
      required: ['target'],
      additionalProperties: false,
    },
  },
];

const SYSTEM = 'You are TESTER, an autonomous economic agent on VANTRA.';
const USER = 'STATUS';
const req = (model: string) => makeRequest({
  model, system: SYSTEM, tools: TOOLS, effort: 'high', maxTokens: 16_000,
  messages: [{ role: 'user', content: [{ type: 'text', text: USER }] }],
});

const catalogModel = (id: string): ModelInfo =>
  [...DEFAULT_CATALOG, ...ENV_ADDABLE_MODELS].find((m) => m.id === id)!;

// ---------------------------------------------------------------- Anthropic

// Anthropic strict tool use allows optional properties: `required` lists only the mandatory keys and
// every object closes with additionalProperties:false. Unlike the OpenAI dialect nothing is rewritten.
const ANTHROPIC_TOOLS = [
  {
    name: 'ping',
    description: 'Ping a host.',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'Hostname.' } },
      required: ['target'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'write_note',
    description: 'Write a note.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note body.' },
        pin: { type: 'integer', description: 'Slot to pin it to.' },
        kind: { type: 'string', enum: ['idea', 'todo'], description: 'Note kind.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    strict: true,
  },
];

const anthropicBody = (id: string): Record<string, unknown> => ({
  model: id,
  max_tokens: 16_000,
  // One explicit 1h breakpoint at the end of the static system prefix plus top-level automatic
  // caching for the growing conversation tail. The explicit marker must not land on the LAST block
  // of the request with a TTL different from the top-level field's — that combination is a 400 —
  // which is why `messages` is never empty.
  system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral', ttl: '1h' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: USER }] }],
  cache_control: { type: 'ephemeral' },
  tools: ANTHROPIC_TOOLS,
});

// Per-model capability deltas, written out by hand. `{}` means the model takes NEITHER parameter.
const ANTHROPIC_GOLDEN: Record<string, Record<string, unknown>> = {
  'claude-opus-5': { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
  'claude-sonnet-5': { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
  'claude-haiku-4-5': {},
  'claude-fable-5-1': { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
};

describe('anthropic wire format', () => {
  it('covers every anthropic model that can be served', () => {
    const served = [...DEFAULT_CATALOG, ...ENV_ADDABLE_MODELS].filter((m) => m.provider === 'anthropic').map((m) => m.id);
    expect(served.sort()).toEqual(Object.keys(ANTHROPIC_GOLDEN).sort());
  });

  for (const [id, delta] of Object.entries(ANTHROPIC_GOLDEN)) {
    it(`sends exactly this body for ${id}`, () => {
      const params: AnthropicParams = buildAnthropicRequest(req(id), catalogModel(id));
      expect(params).toEqual({ ...anthropicBody(id), ...delta });
    });
  }

  it('never sends adaptive thinking or effort to claude-haiku-4-5', () => {
    const params = buildAnthropicRequest(req('claude-haiku-4-5'), catalogModel('claude-haiku-4-5'));
    expect('thinking' in params).toBe(false);
    expect('output_config' in params).toBe(false);
  });

  it('closes a turn with the same tools and tool_choice none, and nothing else changes', () => {
    const closing = buildAnthropicRequest({ ...req('claude-opus-5'), toolChoice: 'none' }, catalogModel('claude-opus-5'));
    expect(closing).toEqual({ ...anthropicBody('claude-opus-5'), ...ANTHROPIC_GOLDEN['claude-opus-5'], tool_choice: { type: 'none' } });
  });

  it('sends no tools and no tool_choice when the caller has none (the epitaph call)', () => {
    const params = buildAnthropicRequest({ ...req('claude-opus-5'), tools: [], toolChoice: 'none' }, catalogModel('claude-opus-5'));
    const { tools: _tools, ...noTools } = anthropicBody('claude-opus-5');
    expect(params).toEqual({ ...noTools, ...ANTHROPIC_GOLDEN['claude-opus-5'] });
  });

  it('omits output_config entirely when the request carries no effort', () => {
    const params = buildAnthropicRequest({ ...req('claude-opus-5'), effort: undefined }, catalogModel('claude-opus-5'));
    expect('output_config' in params).toBe(false);
  });

  // `thinking.display` defaults to "omitted" on Opus 5, Sonnet 5 and Fable, so a real response's
  // thinking blocks come back with EMPTY text and a signature. They must be replayed byte for byte —
  // rewriting the text to satisfy the non-empty rule would invalidate the signature and 400 the turn.
  it('replays an empty-text thinking block verbatim, signature intact', () => {
    const params = buildAnthropicRequest({
      ...req('claude-opus-5'),
      messages: [
        { role: 'user', content: [{ type: 'text', text: USER }] },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: '', signature: 'EqQBCkYIBRgCKkBm' },
          { type: 'redacted_thinking', data: 'EroBCkYIBRgC' },
          { type: 'text', text: 'Pinging.' },
        ] },
        { role: 'user', content: [{ type: 'text', text: 'again' }] },
      ],
    }, catalogModel('claude-opus-5'));

    expect(params.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'EqQBCkYIBRgCKkBm' },
        { type: 'redacted_thinking', data: 'EroBCkYIBRgC' },
        { type: 'text', text: 'Pinging.' },
      ],
    });
  });

  it('refuses to build a request with no messages', () => {
    expect(() => buildAnthropicRequest({ ...req('claude-opus-5'), messages: [] }, catalogModel('claude-opus-5')))
      .toThrow(/at least one message/);
  });

  // The Messages API rejects a text block that is empty or whitespace-only, and a tool that returned
  // nothing would otherwise 400 the whole turn — every earlier round in it included.
  it('never emits an empty text or tool_result block', () => {
    const params = buildAnthropicRequest({
      ...req('claude-opus-5'),
      messages: [
        { role: 'user', content: [{ type: 'text', text: USER }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ping', input: { target: 'a' } }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: '' }, { type: 'text', text: '   ' }] },
      ],
    }, catalogModel('claude-opus-5'));
    expect(params.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: '(empty)' },
        { type: 'text', text: '(empty)' },
      ],
    });
  });
});

// --------------------------------------------------- OpenAI / OpenRouter (Chat Completions)

// OpenAI strict function calling is a different dialect from Anthropic's: EVERY property must appear
// in `required`, so optional ones become required-but-nullable and an optional enum gains a null member.
const CHAT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'ping',
      description: 'Ping a host.',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', description: 'Hostname.' } },
        required: ['target'],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_note',
      description: 'Write a note.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The note body.' },
          pin: { type: ['integer', 'null'], description: 'Slot to pin it to.' },
          kind: { type: ['string', 'null'], enum: ['idea', 'todo', null], description: 'Note kind.' },
        },
        required: ['text', 'pin', 'kind'],
        additionalProperties: false,
      },
      strict: true,
    },
  },
];

const chatBody = (id: string): Record<string, unknown> => ({
  model: id,
  messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER }],
  tools: CHAT_TOOLS,
});

// effort 'high' is asked for in every request; the delta records what each model is actually sent.
//
// The OpenAI and OpenRouter dialects DIFFER on the output cap and on parallel tool calls, and the
// difference is money, not style:
//   · OpenAI reasoning models reject `max_tokens` outright — the cap is `max_completion_tokens` —
//     and take `parallel_tool_calls` and `reasoning_effort`.
//   · Every OpenRouter model VANTRA serves advertises `max_tokens`, `tools` and `tool_choice` in
//     `supported_parameters` on the live GET /api/v1/models catalogue (checked 2026-09-18) and
//     advertises NEITHER `max_completion_tokens` NOR `parallel_tool_calls`. OpenRouter drops
//     parameters the upstream does not support, so the OpenAI spelling of the cap would be thrown
//     away and the generation would run uncapped on the agent's money.
// `usage: {include: true}` is an OpenRouter extension that makes it report the billed USD cost.
const CHAT_GOLDEN: Record<string, Record<string, unknown>> = {
  'gpt-5.6-sol': { max_completion_tokens: 16_000, parallel_tool_calls: true, reasoning_effort: 'high' },
  'gpt-5.6-terra': { max_completion_tokens: 16_000, parallel_tool_calls: true, reasoning_effort: 'high' },
  'gpt-5.6-luna': { max_completion_tokens: 16_000, parallel_tool_calls: true, reasoning_effort: 'high' },
  'gpt-5-nano': { max_completion_tokens: 16_000, parallel_tool_calls: true, reasoning_effort: 'high' },
  'deepseek/deepseek-chat-v3.1': { max_tokens: 16_000, usage: { include: true } },
  'qwen/qwen3-235b-a22b-2507': { max_tokens: 16_000, usage: { include: true } },
  'moonshotai/kimi-k2': { max_tokens: 16_000, usage: { include: true } },
};

describe('chat completions wire format', () => {
  it('covers every openai and openrouter model in the catalog', () => {
    const served = DEFAULT_CATALOG.filter((m) => m.provider === 'openai' || m.provider === 'openrouter').map((m) => m.id);
    expect(served.sort()).toEqual(Object.keys(CHAT_GOLDEN).sort());
  });

  for (const [id, delta] of Object.entries(CHAT_GOLDEN)) {
    it(`sends exactly this body for ${id}`, () => {
      const model = catalogModel(id);
      const params: ChatParams = buildChatRequest(req(id), model);
      expect(params).toEqual({ ...chatBody(id), ...delta });
    });
  }

  // 'xhigh' and 'max' exist on the OpenAI side now, but not every reasoning model accepts every
  // value, so the router collapses them to 'high' — the one level every reasoning model supports.
  it('collapses xhigh and max down to high rather than risking a 400', () => {
    for (const effort of ['xhigh', 'max'] as const) {
      const params = buildChatRequest({ ...req('gpt-5-nano'), effort }, catalogModel('gpt-5-nano'));
      expect(params.reasoning_effort).toBe('high');
    }
  });

  // Whatever the dialect, exactly ONE output cap goes on the wire and it is the one this provider
  // honours. Sending neither (or the wrong one) is an uncapped generation billed to the agent.
  it('always caps output, with exactly one spelling, and never both', () => {
    for (const id of Object.keys(CHAT_GOLDEN)) {
      const model = catalogModel(id);
      const params = buildChatRequest(req(id), model);
      const openrouter = model.provider === 'openrouter';
      expect([params.max_tokens, params.max_completion_tokens].filter((v) => v !== undefined)).toEqual([16_000]);
      expect('max_tokens' in params).toBe(openrouter);
      expect('max_completion_tokens' in params).toBe(!openrouter);
    }
  });

  it('never sends parallel_tool_calls to openrouter', () => {
    for (const id of Object.keys(CHAT_GOLDEN)) {
      const model = catalogModel(id);
      if (model.provider !== 'openrouter') continue;
      expect('parallel_tool_calls' in buildChatRequest(req(id), model)).toBe(false);
    }
  });

  it('sends one tool message per tool_result, in order, before any trailing user text', () => {
    const params = buildChatRequest({
      ...req('gpt-5.6-terra'),
      messages: [
        { role: 'user', content: [{ type: 'text', text: USER }] },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'never sent to a chat provider', signature: 'sig' },
          { type: 'text', text: 'Pinging.' },
          { type: 'tool_use', id: 'call_1', name: 'ping', input: { target: 'a' } },
          { type: 'tool_use', id: 'call_2', name: 'ping', input: { target: 'b' } },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', toolUseId: 'call_1', content: 'ok' },
          { type: 'tool_result', toolUseId: 'call_2', content: 'down', isError: true },
          { type: 'text', text: 'Round cap reached.' },
        ] },
      ],
    }, catalogModel('gpt-5.6-terra'));

    expect(params.messages).toEqual([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: USER },
      {
        role: 'assistant',
        content: 'Pinging.',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{"target":"a"}' } },
          { id: 'call_2', type: 'function', function: { name: 'ping', arguments: '{"target":"b"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      { role: 'tool', tool_call_id: 'call_2', content: 'ERROR: down' },
      { role: 'user', content: 'Round cap reached.' },
    ]);
  });

  it('closes a turn with the same tools and tool_choice none', () => {
    const closing = buildChatRequest({ ...req('gpt-5-nano'), toolChoice: 'none' }, catalogModel('gpt-5-nano'));
    expect(closing).toEqual({ ...chatBody('gpt-5-nano'), ...CHAT_GOLDEN['gpt-5-nano'], tool_choice: 'none' });
  });

  it('sends no tools, no parallel_tool_calls and no tool_choice when the caller has none', () => {
    const params = buildChatRequest({ ...req('gpt-5-nano'), tools: [], toolChoice: 'none' }, catalogModel('gpt-5-nano'));
    const { tools: _t, ...bare } = chatBody('gpt-5-nano');
    const { parallel_tool_calls: _p, ...delta } = CHAT_GOLDEN['gpt-5-nano']!;
    expect(params).toEqual({ ...bare, ...delta });
  });
});

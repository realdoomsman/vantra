// Request-body shape for every model in the catalog, built from fixtures with no network.
import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG, type ModelInfo } from '@vantra/shared';
import { buildAnthropicRequest } from '../../src/llm/providers/anthropic.js';
import { buildChatRequest, toReasoningEffort } from '../../src/llm/providers/chat.js';
import { makeRequest, TOOL_DEFS } from './helpers.js';

const byProvider = (p: ModelInfo['provider']): ModelInfo[] => DEFAULT_CATALOG.filter((m) => m.provider === p);
const sortedToolNames = [...TOOL_DEFS].map((t) => t.name).sort();
// Anthropic's ToolUnion also covers server toolsets, which have no `name`; we never send those.
const anthropicToolName = (t: unknown): string => (t as { name?: string }).name ?? '(toolset)';

describe.each(byProvider('anthropic'))('anthropic request shape: $id', (model) => {
  const params = buildAnthropicRequest(makeRequest({ model: model.id, effort: 'high' }), model);

  it('caches the system prompt for an hour and the conversation tail', () => {
    expect(params.system).toEqual([{ type: 'text', text: expect.any(String), cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect(params.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('sends every tool sorted by name with strict schemas', () => {
    expect(params.tools?.map(anthropicToolName)).toEqual(sortedToolNames);
    for (const tool of params.tools ?? []) {
      expect(tool).toMatchObject({ strict: true, input_schema: expect.objectContaining({ type: 'object' }) });
    }
  });

  it('sends thinking only for adaptive models and effort only when supported', () => {
    expect(params.thinking).toEqual(model.thinking === 'adaptive' ? { type: 'adaptive' } : undefined);
    expect(params.output_config).toEqual(model.supportsEffort ? { effort: 'high' } : undefined);
  });

  it('carries max_tokens and the model id', () => {
    expect(params.model).toBe(model.id);
    expect(params.max_tokens).toBe(16_000);
    expect(params.tool_choice).toBeUndefined();
  });

  it('closes a turn with the SAME tools and tool_choice none (A2)', () => {
    const closing = buildAnthropicRequest(makeRequest({ model: model.id, toolChoice: 'none', maxTokens: 1024 }), model);
    expect(closing.tool_choice).toEqual({ type: 'none' });
    expect(closing.tools?.map(anthropicToolName)).toEqual(sortedToolNames);
    expect(closing.max_tokens).toBe(1024);
  });

  it('omits effort entirely when the request has none', () => {
    expect(buildAnthropicRequest(makeRequest({ model: model.id, effort: undefined }), model).output_config).toBeUndefined();
  });
});

describe.each([...byProvider('openai'), ...byProvider('openrouter')])('chat request shape: $id', (model) => {
  const openrouter = model.provider === 'openrouter';
  const params = buildChatRequest(makeRequest({ model: model.id, effort: 'xhigh' }), model);

  // The output cap MUST bind on both dialects: OpenAI reasoning models reject `max_tokens`, and
  // OpenRouter advertises `max_tokens` (never `max_completion_tokens`) in supported_parameters and
  // silently drops what it does not support — an unbound generation there is an agent's treasury.
  it('puts the system prompt first and caps output with the spelling this provider honours', () => {
    expect(params.messages[0]).toEqual({ role: 'system', content: expect.any(String) });
    expect(params.model).toBe(model.id);
    expect(openrouter ? params.max_tokens : params.max_completion_tokens).toBe(16_000);
    expect(openrouter ? 'max_completion_tokens' in params : 'max_tokens' in params).toBe(false);
  });

  it('sends sorted strict function tools, with parallel calls declared on openai only', () => {
    expect(params.tools?.map((t) => t.type === 'function' && t.function.name)).toEqual(sortedToolNames);
    expect(params.parallel_tool_calls).toBe(openrouter ? undefined : true);
    for (const tool of params.tools ?? []) {
      if (tool.type !== 'function') throw new Error('expected function tool');
      expect(tool.function.strict).toBe(true);
    }
  });

  it('maps effort to reasoning_effort only when the model supports it (A4)', () => {
    expect(params.reasoning_effort).toBe(model.supportsEffort ? 'high' : undefined);
  });

  it('asks for usage accounting on openrouter only (A5)', () => {
    expect(params.usage).toEqual(openrouter ? { include: true } : undefined);
  });

  it('sends tool_choice none for closing completions', () => {
    const closing = buildChatRequest(makeRequest({ model: model.id, toolChoice: 'none' }), model);
    expect(closing.tool_choice).toBe('none');
    expect(closing.tools).toHaveLength(TOOL_DEFS.length);
  });
});

describe('chat message mapping (A7)', () => {
  const model = DEFAULT_CATALOG.find((m) => m.id === 'gpt-5.6-terra')!;

  it('turns tool_use into tool_calls and each tool_result into its own tool message', () => {
    const params = buildChatRequest(makeRequest({
      model: model.id,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'STATUS' }] },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'dropped outbound', signature: 'sig' },
          { type: 'text', text: 'Writing the page.' },
          { type: 'tool_use', id: 'call_1', name: 'write_file', input: { path: 'site/index.html', content: '<h1/>' } },
          { type: 'tool_use', id: 'call_2', name: 'bash', input: { command: 'ls' } },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', toolUseId: 'call_1', content: 'wrote 5 bytes' },
          { type: 'tool_result', toolUseId: 'call_2', content: 'no such file', isError: true },
          { type: 'text', text: 'Round cap reached; finish with a summary' },
        ] },
      ],
    }), model);

    expect(params.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user']);
    const assistant = params.messages[2] as { content: string | null; tool_calls: { id: string; function: { name: string; arguments: string } }[] };
    expect(assistant.content).toBe('Writing the page.');
    expect(assistant.tool_calls.map((c) => [c.id, c.function.name])).toEqual([['call_1', 'write_file'], ['call_2', 'bash']]);
    expect(JSON.parse(assistant.tool_calls[0]!.function.arguments)).toEqual({ path: 'site/index.html', content: '<h1/>' });
    expect(params.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'wrote 5 bytes' });
    expect(params.messages[4]).toEqual({ role: 'tool', tool_call_id: 'call_2', content: 'ERROR: no such file' });
    expect(params.messages[5]).toEqual({ role: 'user', content: 'Round cap reached; finish with a summary' });
  });

  it('sends null content for a tool-only assistant turn', () => {
    const params = buildChatRequest(makeRequest({
      model: model.id,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: {} }] },
      ],
    }), model);
    expect((params.messages[2] as { content: string | null }).content).toBeNull();
  });
});

describe('reasoning effort mapping', () => {
  it('collapses high, xhigh and max to high', () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max'].map((e) => toReasoningEffort(e as never)))
      .toEqual(['low', 'medium', 'high', 'high', 'high']);
  });
});

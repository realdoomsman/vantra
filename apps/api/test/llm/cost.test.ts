// Cost math per provider, from response fixtures (AMENDMENTS A5).
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG, priceUsage, type ModelInfo } from '@vantra/shared';
import { mapAnthropicResponse } from '../../src/llm/providers/anthropic.js';
import { mapChatResponse } from '../../src/llm/providers/chat.js';

const model = (id: string): ModelInfo => DEFAULT_CATALOG.find((m) => m.id === id)!;

function anthropicMessage(over: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'done', citations: null }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 4000, cache_creation_input_tokens: 2000 },
    ...over,
  } as unknown as Anthropic.Message;
}

function chatCompletion(over: Record<string, unknown> = {}): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: 'chatcmpl-1', object: 'chat.completion', created: 0, model: 'gpt-5.6-terra',
    choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'done', refusal: null } }],
    usage: { prompt_tokens: 5000, completion_tokens: 800, total_tokens: 5800, prompt_tokens_details: { cached_tokens: 3000 } },
    ...over,
  } as unknown as OpenAI.Chat.Completions.ChatCompletion;
}

describe('anthropic usage → cost', () => {
  it('prices input, cache write, cache read and output separately', () => {
    const sonnet = model('claude-sonnet-5');   // in 2, out 10 ⇒ cacheRead 0.2, cacheWrite 2.5
    const res = mapAnthropicResponse(anthropicMessage(), sonnet);
    expect(res.usage).toEqual({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 4000, cacheWriteTokens: 2000, costMicro: 12_800 });
    expect(res.usage.costMicro).toBe(priceUsage(sonnet, res.usage));
  });

  it('defaults missing cache counters to zero', () => {
    const res = mapAnthropicResponse(
      anthropicMessage({ usage: { input_tokens: 2000, output_tokens: 100 } as unknown as Anthropic.Usage }),
      model('claude-haiku-4-5'),   // in 1, out 5
    );
    expect(res.usage).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0, costMicro: 2000 * 1 + 100 * 5 });
  });

  it('maps stop reasons and stop details', () => {
    expect(mapAnthropicResponse(anthropicMessage({ stop_reason: 'tool_use' }), model('claude-opus-5')).stopReason).toBe('tool_use');
    expect(mapAnthropicResponse(anthropicMessage({ stop_reason: 'pause_turn' }), model('claude-opus-5')).stopReason).toBe('pause_turn');
    expect(mapAnthropicResponse(anthropicMessage({ stop_reason: 'stop_sequence' }), model('claude-opus-5')).stopReason).toBe('stop_sequence');
    expect(mapAnthropicResponse(anthropicMessage({ stop_reason: null }), model('claude-opus-5')).stopReason).toBe('error');

    const refused = mapAnthropicResponse(anthropicMessage({
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'harmful_content', explanation: 'no' } as unknown as Anthropic.Message['stop_details'],
    }), model('claude-opus-5'));
    expect(refused.stopReason).toBe('refusal');
    expect(refused.stopDetails).toEqual({ category: 'harmful_content', explanation: 'no' });
  });

  it('parses tool inputs as JSON objects, never string matching', () => {
    const res = mapAnthropicResponse(anthropicMessage({
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'a.txt', content: 'x' } },
        { type: 'tool_use', id: 't2', name: 'bash', input: '{"command":"ls -la"}' },
        { type: 'tool_use', id: 't3', name: 'bash', input: 'not json' },
      ] as unknown as Anthropic.ContentBlock[],
    }), model('claude-sonnet-5'));
    expect(res.content).toEqual([
      { type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'a.txt', content: 'x' } },
      { type: 'tool_use', id: 't2', name: 'bash', input: { command: 'ls -la' } },
      { type: 'tool_use', id: 't3', name: 'bash', input: 'not json' },
    ]);
  });
});

describe('openai usage → cost', () => {
  const terra = model('gpt-5.6-terra');   // in 2, out 12 ⇒ cacheRead 0.2

  it('prices the cached prompt subset at the cache-read rate', () => {
    const res = mapChatResponse(chatCompletion(), terra, { costFromUsage: false });
    expect(res.usage).toEqual({ inputTokens: 2000, cacheReadTokens: 3000, cacheWriteTokens: 0, outputTokens: 800, costMicro: 14_200 });
  });

  it('ignores a reported cost because only openrouter bills one', () => {
    const usage = { prompt_tokens: 5000, completion_tokens: 800, total_tokens: 5800, prompt_tokens_details: { cached_tokens: 3000 }, cost: 99 };
    expect(mapChatResponse(chatCompletion({ usage }), terra, { costFromUsage: false }).usage.costMicro).toBe(14_200);
  });

  it('maps finish reasons, tool calls and refusals', () => {
    const tools = chatCompletion({
      choices: [{ index: 0, finish_reason: 'tool_calls', logprobs: null, message: {
        role: 'assistant', content: null, refusal: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
      } }],
    });
    const res = mapChatResponse(tools, terra, { costFromUsage: false });
    expect(res.stopReason).toBe('tool_use');
    expect(res.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'ls' } }]);

    expect(mapChatResponse(chatCompletion({ choices: [{ index: 0, finish_reason: 'length', logprobs: null, message: { role: 'assistant', content: 'cut', refusal: null } }] }), terra, { costFromUsage: false }).stopReason).toBe('max_tokens');
    expect(mapChatResponse(chatCompletion({ choices: [{ index: 0, finish_reason: 'content_filter', logprobs: null, message: { role: 'assistant', content: '', refusal: null } }] }), terra, { costFromUsage: false }).stopReason).toBe('refusal');

    const refused = mapChatResponse(chatCompletion({ choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' } }] }), terra, { costFromUsage: false });
    expect(refused.stopReason).toBe('refusal');
    expect(refused.stopDetails).toEqual({ category: null, explanation: 'I cannot help with that.' });
  });

  it('treats tool calls returned with finish_reason stop as tool_use', () => {
    const completion = chatCompletion({
      choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: {
        role: 'assistant', content: null, refusal: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
      } }],
    });
    expect(mapChatResponse(completion, terra, { costFromUsage: false }).stopReason).toBe('tool_use');
  });
});

describe('openrouter usage → cost', () => {
  const deepseek = model('deepseek/deepseek-chat-v3.1');   // live OpenRouter catalogue: in 0.25, out 0.95

  it('treats usage.cost (USD) as authoritative', () => {
    const usage = { prompt_tokens: 5000, completion_tokens: 800, total_tokens: 5800, cost: 0.0042 };
    expect(mapChatResponse(chatCompletion({ usage, model: deepseek.id }), deepseek, { costFromUsage: true }).usage.costMicro).toBe(4200);
  });

  it('falls back to catalog pricing when no cost is reported', () => {
    const usage = { prompt_tokens: 5000, completion_tokens: 800, total_tokens: 5800 };
    const res = mapChatResponse(chatCompletion({ usage, model: deepseek.id }), deepseek, { costFromUsage: true });
    expect(res.usage).toEqual({ inputTokens: 5000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 800, costMicro: 2010 });
  });

  it('rounds a sub-micro cost up rather than to zero', () => {
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.0000004 };
    expect(mapChatResponse(chatCompletion({ usage, model: deepseek.id }), deepseek, { costFromUsage: true }).usage.costMicro).toBe(1);
  });
});

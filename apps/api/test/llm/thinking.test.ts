// Thinking blocks survive three model↔tool rounds unchanged (AMENDMENTS A1): Anthropic maps them
// 1:1 both ways and the step loop replays res.content verbatim; the chat providers drop them.
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG } from '@vantra/shared';
import type { LlmMessage } from '../../src/core/interfaces.js';
import { buildAnthropicRequest, mapAnthropicResponse } from '../../src/llm/providers/anthropic.js';
import { buildChatRequest } from '../../src/llm/providers/chat.js';
import { makeRequest, STATUS_TEXT, userTurn } from './helpers.js';

const sonnet = DEFAULT_CATALOG.find((m) => m.id === 'claude-sonnet-5')!;
const terra = DEFAULT_CATALOG.find((m) => m.id === 'gpt-5.6-terra')!;

const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function round(n: number, stopReason: Anthropic.StopReason): Anthropic.Message {
  return {
    id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_sequence: null,
    stop_reason: stopReason, usage,
    content: [
      { type: 'thinking', thinking: `round ${n}: weigh the cost against the runway`, signature: `sig-${n}` },
      ...(n === 2 ? [{ type: 'redacted_thinking', data: `redacted-${n}` }] : []),
      { type: 'text', text: `Step ${n} note.` },
      ...(stopReason === 'tool_use' ? [{ type: 'tool_use', id: `t${n}`, name: 'bash', input: { command: `echo ${n}` } }] : []),
    ],
  } as unknown as Anthropic.Message;
}

describe('thinking round trip across 3 rounds', () => {
  const messages: LlmMessage[] = [userTurn(STATUS_TEXT())];
  const sentAssistantTurns: Anthropic.MessageParam[] = [];

  for (let n = 1; n <= 3; n++) {
    const stopReason: Anthropic.StopReason = n < 3 ? 'tool_use' : 'end_turn';
    const params = buildAnthropicRequest(makeRequest({ model: sonnet.id, messages: [...messages] }), sonnet);
    sentAssistantTurns.push(...params.messages.filter((m) => m.role === 'assistant'));

    const res = mapAnthropicResponse(round(n, stopReason), sonnet);
    messages.push({ role: 'assistant', content: res.content });          // replayed verbatim by the step loop
    if (stopReason === 'tool_use') messages.push({ role: 'user', content: [{ type: 'tool_result', toolUseId: `t${n}`, content: `${n}` }] });
  }

  it('maps thinking and redacted_thinking into LlmContent 1:1', () => {
    expect(messages[1]!.content[0]).toEqual({ type: 'thinking', thinking: 'round 1: weigh the cost against the runway', signature: 'sig-1' });
    expect(messages[3]!.content[1]).toEqual({ type: 'redacted_thinking', data: 'redacted-2' });
  });

  it('sends every earlier thinking block back with its signature intact', () => {
    // Round 1 sends none, round 2 sends turn 1, round 3 sends turns 1 and 2.
    expect(sentAssistantTurns).toHaveLength(3);
    const blocks = sentAssistantTurns.flatMap((turn) => (Array.isArray(turn.content) ? turn.content : []));
    expect(blocks.filter((b) => b.type === 'thinking')).toEqual([
      { type: 'thinking', thinking: 'round 1: weigh the cost against the runway', signature: 'sig-1' },
      { type: 'thinking', thinking: 'round 1: weigh the cost against the runway', signature: 'sig-1' },
      { type: 'thinking', thinking: 'round 2: weigh the cost against the runway', signature: 'sig-2' },
    ]);
    expect(blocks.filter((b) => b.type === 'redacted_thinking')).toEqual([{ type: 'redacted_thinking', data: 'redacted-2' }]);
  });

  it('keeps the thinking block first in each replayed turn, before text and tool_use', () => {
    for (const turn of sentAssistantTurns) {
      const content = Array.isArray(turn.content) ? turn.content : [];
      expect(content[0]?.type).toBe('thinking');
      expect(content.map((b) => b.type)).toContain('tool_use');
    }
  });

  it('drops thinking blocks on the chat providers (A1)', () => {
    const params = buildChatRequest(makeRequest({ model: terra.id, messages }), terra);
    expect(JSON.stringify(params.messages)).not.toContain('sig-1');
    expect(JSON.stringify(params.messages)).not.toContain('redacted-2');
    expect(JSON.stringify(params.messages)).not.toContain('weigh the cost');
    expect(params.messages.filter((m) => m.role === 'assistant')).toHaveLength(3);
  });
});

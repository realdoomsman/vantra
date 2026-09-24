// GET /ws over a real socket: hello on connect, every bus message broadcast, nothing sensitive on the wire.
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { FeedEvent, StepPublic, WsMsg } from '@vantra/shared';
import { stripSensitive } from '../../src/http/sanitize.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { AGENT_A, makeTreasury } from './helpers/fixtures.js';

let t: TestApp;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await t?.close();
});

const EVENT: FeedEvent = { id: 1, ts: '2026-09-16T00:00:00.000Z', kind: 'spawn', agentId: AGENT_A, agentName: 'ALPHA', text: 'ALPHA was spawned', amountMicro: null, meta: {} };

async function connect(): Promise<{ socket: WebSocket; messages: WsMsg[] }> {
  const { port } = t.app.server.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(socket);
  const messages: WsMsg[] = [];
  socket.on('message', (data) => messages.push(JSON.parse(String(data)) as WsMsg));
  await once(socket, 'open');
  await waitFor(() => messages.length >= 1);
  return { socket, messages };
}

async function waitFor(done: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a websocket message');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('websocket', () => {
  it('greets each client with stats and broadcasts every bus message', async () => {
    t = await buildTestApp();
    await t.app.listen({ port: 0, host: '127.0.0.1' });

    const a = await connect();
    const hello = a.messages[0]!;
    expect(hello.type).toBe('hello');
    if (hello.type !== 'hello') throw new Error('expected hello');
    expect(hello.stats.alive).toBe(t.services.statsValue.alive);
    // Public catalog fields survive the sanitizer (ModelInfo.thinking is not a reasoning block).
    expect(hello.stats.llm.models[0]!.thinking).toBe(t.services.statsValue.llm.models[0]!.thinking);

    const b = await connect();
    expect(b.messages[0]!.type).toBe('hello');

    t.deps.bus.emit({ type: 'event', event: EVENT });
    t.deps.bus.emit({ type: 'agent', agentId: AGENT_A, patch: { treasuryMicro: 42, stepping: true, phase: 'building' } });
    await waitFor(() => a.messages.length >= 3 && b.messages.length >= 3);

    for (const client of [a, b]) {
      expect(client.messages[1]).toEqual({ type: 'event', event: EVENT });
      expect(client.messages[2]).toEqual({ type: 'agent', agentId: AGENT_A, patch: { treasuryMicro: 42, stepping: true, phase: 'building' } });
    }

    // A closed client stops receiving without breaking the other one.
    b.socket.close();
    await waitFor(() => b.socket.readyState === WebSocket.CLOSED);
    t.deps.bus.emit({ type: 'event', event: { ...EVENT, id: 2 } });
    await waitFor(() => a.messages.length >= 4);
    expect(b.messages).toHaveLength(3);
  });

  it('strips thinking and transcripts from anything a producer broadcasts', async () => {
    t = await buildTestApp();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const a = await connect();

    const step = {
      id: 7, agentId: AGENT_A, n: 3, startedAt: EVENT.ts, finishedAt: null, model: 'mock-fast', effort: 'medium',
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costMicro: 100, toolCalls: 1,
      rounds: 1, stopReason: 'tool_use', status: 'running', summary: '', error: null,
      transcript: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'secret reasoning', signature: 'sig' }] }],
    } as unknown as StepPublic;

    t.deps.bus.emit({ type: 'step', step });
    await waitFor(() => a.messages.length >= 2);
    const received = a.messages[1]!;
    if (received.type !== 'step') throw new Error('expected step');
    expect(received.step).not.toHaveProperty('transcript');
    expect(received.step.n).toBe(3);
    expect(JSON.stringify(received)).not.toContain('secret reasoning');
  });

  // SPEC-V2 §3.5: the pool message became a treasury message, and purchases are never broadcast.
  it('broadcasts treasury updates and nothing about a purchase', async () => {
    t = await buildTestApp();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const a = await connect();

    const treasury = makeTreasury({ usdcMicro: 123_000_000 });
    t.deps.bus.emit({ type: 'treasury', treasury });
    await waitFor(() => a.messages.length >= 2);
    expect(a.messages[1]).toEqual({ type: 'treasury', treasury });

    // Nothing a purchase produces reaches the socket: a buyer's page polls instead.
    expect(a.messages.map((m) => m.type)).not.toContain('purchase');
  });

  it('ignores anything the client sends', async () => {
    t = await buildTestApp();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const a = await connect();
    a.socket.send('{"type":"admin"}');
    t.deps.bus.emit({ type: 'event', event: EVENT });
    await waitFor(() => a.messages.length >= 2);
    expect(a.socket.readyState).toBe(WebSocket.OPEN);
    expect(a.messages.map((m) => m.type)).toEqual(['hello', 'event']);
  });
});

describe('stripSensitive', () => {
  it('drops reasoning blocks and key material wherever they appear', () => {
    const payload = {
      content: [{ type: 'text', text: 'hi' }, { type: 'thinking', thinking: 'x', signature: 's' }, { type: 'redacted_thinking', data: 'z' }],
      nested: { secret: 'k', fromSecret: [1, 2], keep: 1, block: { type: 'thinking', thinking: 'x', signature: 's' } },
      model: { id: 'claude-sonnet-5', thinking: 'adaptive' },
      ownerMessages: [{ text: 'private' }],
    };
    expect(stripSensitive(payload)).toEqual({
      content: [{ type: 'text', text: 'hi' }],
      nested: { keep: 1 },
      model: { id: 'claude-sonnet-5', thinking: 'adaptive' },
    });
  });

  // SPEC-V2 §8.5: everything a purchase row carries that could impersonate its buyer.
  it('drops claim codes, deposit key material and owner ids', () => {
    const payload = {
      id: 'pu_aaaaaaaaaa', depositPubkey: 'Deposit111', keep: 1,
      claimCode: 'RW-ABCDE-FGHJK-MNPQR-STVWX', claimCodeHash: 'hash', claim_code_hash: 'hash',
      depositSecretEnc: 'enc', deposit_secret_enc: 'enc', depositIv: 'iv', depositTag: 'tag',
      treasurySecret: [1, 2], ownerId: 'claim_pu_aaaaaaaaaa',
      nested: { ownerId: 'claim_pu_aaaaaaaaaa', fine: true },
    };
    expect(stripSensitive(payload)).toEqual({
      id: 'pu_aaaaaaaaaa', depositPubkey: 'Deposit111', keep: 1, nested: { fine: true },
    });
  });
});

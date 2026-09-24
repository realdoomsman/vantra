// Router: model resolution, retries with an identical body, and pricing refresh (SPEC §8.5, A5/A6).
import { describe, expect, it, vi } from 'vitest';
import { estimateMicro } from '@vantra/shared';
import type { LlmProvider, LlmRequest, LlmResponse } from '../../src/core/interfaces.js';
import { silentLogger } from '../../src/lib/log.js';
import { LlmCallError } from '../../src/llm/errors.js';
import { createRouter, LLM_MAX_ATTEMPTS } from '../../src/llm/router.js';
import { makeRequest, testConfig } from './helpers.js';

const ok = (over: Partial<LlmResponse> = {}): LlmResponse => ({
  content: [{ type: 'text', text: 'done' }],
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costMicro: 42 },
  model: 'claude-sonnet-5',
  ...over,
});

function stubProvider(name: LlmProvider['name'], complete: LlmProvider['complete']): LlmProvider {
  return { name, complete };
}

const routerConfig = (over: Record<string, string> = {}) =>
  testConfig({ LLM_PROVIDER: 'router', ANTHROPIC_API_KEY: 'sk-ant-test', ...over });

describe('resolve and models', () => {
  const router = createRouter({ config: routerConfig(), log: silentLogger });

  it('lists only enabled models', () => {
    expect(router.models().map((m) => m.id)).toEqual(['claude-haiku-4-5', 'claude-opus-5', 'claude-sonnet-5']);
    expect(router.mode).toBe('router');
  });

  it('resolves a catalog model', () => {
    expect(router.resolve('claude-sonnet-5')).toMatchObject({ provider: 'anthropic', thinking: 'adaptive' });
  });

  it('throws on an unknown model and on one disabled by config', () => {
    expect(() => router.resolve('gpt-9')).toThrow(/Unknown model/);
    expect(() => router.resolve('gpt-5-nano')).toThrow(/no OPENAI_API_KEY/);
  });

  it('exposes cheapest() and estimateMicro() consistently', () => {
    const cheapest = router.cheapest();
    expect(cheapest.id).toBe('claude-haiku-4-5');
    expect(router.estimateMicro(cheapest, 6000, 1000)).toBe(estimateMicro(cheapest, 6000, 1000));
    for (const m of router.models()) {
      expect(router.estimateMicro(m, 3000, 600)).toBeGreaterThanOrEqual(router.estimateMicro(cheapest, 3000, 600));
    }
  });

  it('serves the mock provider in mock mode', async () => {
    const mock = createRouter({ config: testConfig(), log: silentLogger });
    expect(mock.mode).toBe('mock');
    expect(mock.models().map((m) => m.id)).toEqual(['mock-fast', 'mock-strong']);
    const res = await mock.complete(makeRequest());
    expect(res.usage.costMicro).toBeGreaterThan(0);
  });
});

describe('retries (A6)', () => {
  const retryableError = () => new LlmCallError('anthropic', 'HTTP 429: slow down', { status: 429, retryable: true });

  it('retries a retryable failure up to the attempt limit with the identical body', async () => {
    const seen: LlmRequest[] = [];
    const complete = vi.fn(async (req: LlmRequest) => { seen.push(req); throw retryableError(); });
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
    const router = createRouter({ config: routerConfig(), log: silentLogger, providers: { anthropic: stubProvider('anthropic', complete) }, sleep });

    await expect(router.complete(makeRequest({ model: 'claude-sonnet-5' }))).rejects.toThrow(/429/);
    expect(complete).toHaveBeenCalledTimes(LLM_MAX_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(LLM_MAX_ATTEMPTS - 1);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
    expect(seen.every((r) => r === seen[0])).toBe(true);
  });

  it('returns the first success after a transient failure', async () => {
    let calls = 0;
    const complete = async (): Promise<LlmResponse> => {
      if (++calls === 1) throw new LlmCallError('anthropic', 'network error', { retryable: true });
      return ok();
    };
    const router = createRouter({ config: routerConfig(), log: silentLogger, providers: { anthropic: stubProvider('anthropic', complete) }, sleep: async () => {} });
    await expect(router.complete(makeRequest({ model: 'claude-sonnet-5' }))).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(calls).toBe(2);
  });

  it('does not retry a non-retryable failure', async () => {
    const complete = vi.fn(async () => { throw new LlmCallError('anthropic', 'HTTP 400: bad request', { status: 400, retryable: false }); });
    const router = createRouter({ config: routerConfig(), log: silentLogger, providers: { anthropic: stubProvider('anthropic', complete) }, sleep: async () => {} });
    await expect(router.complete(makeRequest({ model: 'claude-sonnet-5' }))).rejects.toThrow(/400/);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  // A6 puts the per-request timeout at min(remaining step budget, 300s) and makes the router own
  // retries, so it must not start one the step has no time left for.
  it('passes the remaining step budget down and shortens it for each retry', async () => {
    const seen: (number | undefined)[] = [];
    const complete = vi.fn(async (req: LlmRequest) => { seen.push(req.remainingMs); throw retryableError(); });
    const router = createRouter({ config: routerConfig(), log: silentLogger, providers: { anthropic: stubProvider('anthropic', complete) }, sleep: async () => {} });

    await expect(router.complete(makeRequest({ model: 'claude-sonnet-5', remainingMs: 120_000 }))).rejects.toThrow(/429/);
    expect(complete).toHaveBeenCalledTimes(LLM_MAX_ATTEMPTS);
    expect(seen).toHaveLength(LLM_MAX_ATTEMPTS);
    expect(seen[0]).toBeLessThanOrEqual(120_000);
    expect(seen[1]!).toBeLessThanOrEqual(seen[0]!);        // the deadline only moves one way
    expect(seen[2]!).toBeLessThanOrEqual(seen[1]!);
  });

  it('does not start a retry it has no step budget for', async () => {
    const complete = vi.fn(async () => { throw retryableError(); });
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
    const router = createRouter({ config: routerConfig(), log: silentLogger, providers: { anthropic: stubProvider('anthropic', complete) }, sleep });

    await expect(router.complete(makeRequest({ model: 'claude-sonnet-5', remainingMs: 300 }))).rejects.toThrow(/429/);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('leaves the request untouched when no budget is given', async () => {
    const seen: LlmRequest[] = [];
    const complete = vi.fn(async (req: LlmRequest) => { seen.push(req); throw retryableError(); });
    const router = createRouter({ config: routerConfig(), log: silentLogger, providers: { anthropic: stubProvider('anthropic', complete) }, sleep: async () => {} });

    const req = makeRequest({ model: 'claude-sonnet-5' });
    await expect(router.complete(req)).rejects.toThrow(/429/);
    expect(seen.every((r) => r === req)).toBe(true);
  });

  it('stops retrying once the step has been aborted', async () => {
    const controller = new AbortController();
    const complete = vi.fn(async () => { controller.abort(); throw new LlmCallError('anthropic', 'timeout', { retryable: true }); });
    const router = createRouter({ config: routerConfig(), log: silentLogger, providers: { anthropic: stubProvider('anthropic', complete) }, sleep: async () => {} });
    await expect(router.complete(makeRequest({ model: 'claude-sonnet-5', signal: controller.signal }))).rejects.toThrow(/timeout/);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe('cache-miss warning (A6)', () => {
  it('warns when a continued conversation reads nothing back from cache', async () => {
    const warn = vi.fn();
    const log = { ...silentLogger, warn, info: () => {} } as unknown as typeof silentLogger;
    const router = createRouter({ config: routerConfig(), log, providers: { anthropic: stubProvider('anthropic', async () => ok()) } });

    await router.complete(makeRequest({ model: 'claude-sonnet-5' }));
    expect(warn).not.toHaveBeenCalled();

    await router.complete(makeRequest({
      model: 'claude-sonnet-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'STATUS' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'thinking about it' }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }] },
      ],
    }));
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-5' }), expect.stringContaining('cache miss'));
  });
});

describe('refreshPricing (A5)', () => {
  const orConfig = () => testConfig({ LLM_PROVIDER: 'router', OPENROUTER_API_KEY: 'or-key' });

  it('rewrites openrouter prices from per-token to per-1M', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      data: [{ id: 'moonshotai/kimi-k2', pricing: { prompt: '0.0000008', completion: '0.0000032' } }],
    }), { status: 200 })) as unknown as typeof fetch;
    const router = createRouter({ config: orConfig(), log: silentLogger, fetchImpl });

    await router.refreshPricing();
    const kimi = router.models().find((m) => m.id === 'moonshotai/kimi-k2');
    expect(kimi?.inputPerM).toBeCloseTo(0.8, 6);
    expect(kimi?.outputPerM).toBeCloseTo(3.2, 6);
  });

  it('tolerates a failing refresh and keeps catalog prices', async () => {
    const fetchImpl = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const router = createRouter({ config: orConfig(), log: silentLogger, fetchImpl });
    await expect(router.refreshPricing()).resolves.toBeUndefined();
    expect(router.models().find((m) => m.id === 'moonshotai/kimi-k2')?.inputPerM).toBe(0.57);
  });

  it('is a no-op without an openrouter key', async () => {
    const fetchImpl = vi.fn();
    const router = createRouter({ config: routerConfig(), log: silentLogger, fetchImpl: fetchImpl as unknown as typeof fetch });
    await router.refreshPricing();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

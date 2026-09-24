// The founder's requirement: adding a key is the only remaining step, and NOTHING silently degrades
// to the mock brain. This file proves every door is bolted — config load, catalog build, model
// resolution, provider construction — and that each failure names the environment variable to set.
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { LlmResponse } from '../../src/core/interfaces.js';
import { silentLogger } from '../../src/lib/log.js';
import { buildCatalog, catalogEnv } from '../../src/llm/catalog.js';
import { createRouter } from '../../src/llm/router.js';
import { makeRequest, testConfig } from './helpers.js';

describe('LLM_PROVIDER=router refuses to start without a key', () => {
  it('throws at config load and names all three keys', () => {
    let thrown: unknown;
    try {
      loadConfig({ NODE_ENV: 'test', LLM_PROVIDER: 'router' } as NodeJS.ProcessEnv);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']) expect(message).toContain(key);
  });

  it('accepts any single key', () => {
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']) {
      expect(() => loadConfig({ NODE_ENV: 'test', LLM_PROVIDER: 'router', [key]: 'k' } as NodeJS.ProcessEnv)).not.toThrow();
    }
  });

  it('refuses DEMO=1 next to a real provider', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', DEMO: '1', LLM_PROVIDER: 'router', ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv))
      .toThrow(/DEMO=1 requires/);
  });
});

describe('no silent fall back to the mock brain', () => {
  it('never enables a mock model in router mode', () => {
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']) {
      const { models, disabled } = buildCatalog(catalogEnv(testConfig({ LLM_PROVIDER: 'router', [key]: 'k' })));
      expect(models.filter((m) => m.enabled).some((m) => m.provider === 'mock')).toBe(false);
      expect(disabled.get('mock-fast')).toMatch(/only served when LLM_PROVIDER=mock/);
      expect(disabled.get('mock-strong')).toMatch(/only served when LLM_PROVIDER=mock/);
    }
  });

  it('never serves a real model in mock mode, even one named in LLM_ALLOWED_MODELS', () => {
    const { models } = buildCatalog(catalogEnv(testConfig({ LLM_ALLOWED_MODELS: 'claude-opus-5' })));
    expect(models.filter((m) => m.enabled).map((m) => m.id)).toEqual(['mock-fast', 'mock-strong']);
  });

  it('refuses to boot the router when the keys and the allow-list cannot agree on a model', () => {
    expect(() => buildCatalog(catalogEnv(testConfig({
      LLM_PROVIDER: 'router', OPENROUTER_API_KEY: 'or-key', LLM_ALLOWED_MODELS: 'claude-opus-5',
    })))).toThrow(/no enabled LLM models/);
  });

  it('names the missing key when a model resolves but its provider cannot be built', () => {
    // Anthropic is keyed, so the catalog enables its models; OpenAI is not, so gpt-5-nano is disabled
    // and resolve() says why instead of quietly routing the call somewhere else.
    const router = createRouter({ config: testConfig({ LLM_PROVIDER: 'router', ANTHROPIC_API_KEY: 'k' }), log: silentLogger });
    expect(() => router.resolve('gpt-5-nano')).toThrow(/no OPENAI_API_KEY/);
    expect(() => router.resolve('mock-strong')).toThrow(/only served when LLM_PROVIDER=mock/);
    expect(() => router.resolve('claude-fable-5-1')).toThrow(/Unknown model/);
  });

  it('routes an anthropic model to the anthropic provider and nowhere else', async () => {
    const seen: string[] = [];
    const record = (name: 'anthropic' | 'mock') => ({
      name,
      complete: async (): Promise<LlmResponse> => {
        seen.push(name);
        return { content: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costMicro: 1 }, model: 'x' };
      },
    });
    const router = createRouter({
      config: testConfig({ LLM_PROVIDER: 'router', ANTHROPIC_API_KEY: 'k' }),
      log: silentLogger,
      providers: { anthropic: record('anthropic'), mock: record('mock') },
    });
    await router.complete(makeRequest({ model: 'claude-sonnet-5' }));
    expect(seen).toEqual(['anthropic']);
  });
});

describe('an unmeterable completion is loud, not free', () => {
  const zeroUsage: LlmResponse = {
    content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', model: 'claude-sonnet-5',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicro: 0 },
  };

  const routerWith = (res: LlmResponse, warn: ReturnType<typeof vi.fn>) => createRouter({
    config: testConfig({ LLM_PROVIDER: 'router', ANTHROPIC_API_KEY: 'k' }),
    log: { ...silentLogger, warn } as unknown as typeof silentLogger,
    providers: { anthropic: { name: 'anthropic', complete: async () => res } },
  });

  it('warns when a provider returns no usable usage accounting', async () => {
    const warn = vi.fn();
    await routerWith(zeroUsage, warn).complete(makeRequest({ model: 'claude-sonnet-5' }));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-5' }),
      expect.stringContaining('billed to the agent at zero'),
    );
  });

  it('stays quiet on a normally metered completion', async () => {
    const warn = vi.fn();
    const metered: LlmResponse = { ...zeroUsage, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costMicro: 300 } };
    await routerWith(metered, warn).complete(makeRequest({ model: 'claude-sonnet-5' }));
    expect(warn).not.toHaveBeenCalled();
  });
});

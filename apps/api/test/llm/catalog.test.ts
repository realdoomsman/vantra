import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG, estimateMicro } from '@vantra/shared';
import { buildCatalog, catalogEnv, cheapestOf, parseModelSpec, refreshOpenRouterPricing } from '../../src/llm/catalog.js';
import { testConfig } from './helpers.js';

const env = (over: Record<string, string> = {}) => catalogEnv(testConfig(over));

describe('catalog gating', () => {
  it('serves only mock models when LLM_PROVIDER=mock', () => {
    const { models, disabled } = buildCatalog(env());
    expect(models.filter((m) => m.enabled).map((m) => m.id)).toEqual(['mock-fast', 'mock-strong']);
    expect(disabled.get('claude-sonnet-5')).toBe('LLM_PROVIDER=mock');
  });

  it('disables providers whose key is missing and never serves mock models in router mode', () => {
    const { models, disabled } = buildCatalog(env({ LLM_PROVIDER: 'router', ANTHROPIC_API_KEY: 'sk-ant-test' }));
    const enabled = models.filter((m) => m.enabled).map((m) => m.id);
    expect(enabled).toEqual(['claude-haiku-4-5', 'claude-opus-5', 'claude-sonnet-5']);
    expect(disabled.get('gpt-5-nano')).toBe('no OPENAI_API_KEY');
    expect(disabled.get('deepseek/deepseek-chat-v3.1')).toBe('no OPENROUTER_API_KEY');
    expect(disabled.get('mock-fast')).toMatch(/only served when LLM_PROVIDER=mock/);
  });

  it('restricts the catalog to LLM_ALLOWED_MODELS', () => {
    const { models, disabled } = buildCatalog(env({
      LLM_PROVIDER: 'router', ANTHROPIC_API_KEY: 'sk-ant-test', LLM_ALLOWED_MODELS: 'claude-haiku-4-5',
    }));
    expect(models.filter((m) => m.enabled).map((m) => m.id)).toEqual(['claude-haiku-4-5']);
    expect(disabled.get('claude-opus-5')).toBe('not in LLM_ALLOWED_MODELS');
  });

  it('adds env-only models by id and by provider:id:in:out[:ctxK] spec', () => {
    const { models } = buildCatalog(env({
      LLM_PROVIDER: 'router',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENAI_API_KEY: 'sk-oai-test',
      LLM_ALLOWED_MODELS: 'claude-fable-5-1,openai:gpt-5.6-nova:1.5:9:600',
    }));
    const fable = models.find((m) => m.id === 'claude-fable-5-1');
    expect(fable).toMatchObject({ provider: 'anthropic', thinking: 'adaptive', supportsEffort: true, enabled: true });
    expect(models.find((m) => m.id === 'gpt-5.6-nova')).toMatchObject({
      provider: 'openai', inputPerM: 1.5, outputPerM: 9, contextK: 600, thinking: 'none', enabled: true,
    });
  });

  it('rejects an unknown LLM_ALLOWED_MODELS entry', () => {
    expect(() => buildCatalog(env({ LLM_PROVIDER: 'router', ANTHROPIC_API_KEY: 'k', LLM_ALLOWED_MODELS: 'not-a-model' })))
      .toThrow(/unknown model/);
  });

  it('parses a model spec and rejects malformed ones', () => {
    expect(parseModelSpec('openrouter:z-ai/glm-5:0.3:1.2')).toMatchObject({ provider: 'openrouter', id: 'z-ai/glm-5', supportsEffort: false });
    expect(parseModelSpec('openai:gpt:abc:2')).toBeNull();
    expect(parseModelSpec('claude-opus-5')).toBeNull();
  });

  // An env-added model goes straight onto the wire, so a capability guess that is wrong for the
  // family is a 400 on the first real call. Haiku rejects both adaptive thinking and effort.
  it('never gives an env-added Haiku adaptive thinking or effort', () => {
    for (const id of ['claude-haiku-4-5-20251001', 'claude-haiku-5', 'claude-3-5-haiku-20241022']) {
      expect(parseModelSpec(`anthropic:${id}:1:5`)).toMatchObject({ id, thinking: 'none', supportsEffort: false });
    }
  });

  it('gives env-added Opus, Sonnet, Fable and Mythos adaptive thinking and effort', () => {
    for (const id of ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-fable-5', 'claude-mythos-5-1']) {
      expect(parseModelSpec(`anthropic:${id}:5:25`)).toMatchObject({ id, thinking: 'adaptive', supportsEffort: true });
    }
  });

  it('gives env-added OpenAI models effort but no thinking, and OpenRouter neither', () => {
    expect(parseModelSpec('openai:gpt-5.6-nova:1.5:9')).toMatchObject({ thinking: 'none', supportsEffort: true });
    expect(parseModelSpec('openrouter:z-ai/glm-5:0.3:1.2')).toMatchObject({ thinking: 'none', supportsEffort: false });
  });
});

describe('cheapest (B14)', () => {
  it('minimises estimateMicro(m, 3000, 600)', () => {
    const { models } = buildCatalog(env({ LLM_PROVIDER: 'router', ANTHROPIC_API_KEY: 'k' }));
    const cheapest = cheapestOf(models);
    expect(cheapest.id).toBe('claude-haiku-4-5');
    const cost = estimateMicro(cheapest, 3000, 600);
    for (const m of models.filter((x) => x.enabled)) expect(estimateMicro(m, 3000, 600)).toBeGreaterThanOrEqual(cost);
  });

  it('picks the cheap mock model in mock mode', () => {
    expect(cheapestOf(buildCatalog(env()).models).id).toBe('mock-fast');
  });
});

describe('openrouter pricing refresh (A5)', () => {
  const body = {
    data: [
      { id: 'deepseek/deepseek-chat-v3.1', pricing: { prompt: '0.00000027', completion: '0.0000011', input_cache_read: '0.00000007' } },
      { id: 'moonshotai/kimi-k2', pricing: { prompt: 0.0000006, completion: 0.0000025 } },
    ],
  };

  it('converts per-token prices to USD per 1M tokens', async () => {
    const models = DEFAULT_CATALOG.map((m) => ({ ...m }));
    const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const updated = await refreshOpenRouterPricing(models, 'or-key', fetchImpl);

    expect(updated).toEqual(['deepseek/deepseek-chat-v3.1', 'moonshotai/kimi-k2']);
    const deepseek = models.find((m) => m.id === 'deepseek/deepseek-chat-v3.1');
    expect(deepseek?.inputPerM).toBeCloseTo(0.27, 6);
    expect(deepseek?.outputPerM).toBeCloseTo(1.1, 6);
    expect(deepseek?.cacheReadPerM).toBeCloseTo(0.07, 6);
    expect(models.find((m) => m.id === 'moonshotai/kimi-k2')?.inputPerM).toBeCloseTo(0.6, 6);
    // Untouched: qwen is absent from the response, anthropic is not an openrouter model.
    expect(models.find((m) => m.id === 'qwen/qwen3-235b-a22b-2507')?.inputPerM).toBe(0.0875);
    expect(models.find((m) => m.id === 'claude-opus-5')?.inputPerM).toBe(5);
  });

  it('throws on a non-200 so the router can tolerate the failure', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    await expect(refreshOpenRouterPricing([], 'or-key', fetchImpl)).rejects.toThrow(/HTTP 503/);
  });
});

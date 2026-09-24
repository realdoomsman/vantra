// Default model catalog. SPEC §6 with AMENDMENTS A4 (thinking modes, effort support).
// Prices are USD per 1M tokens as of 2026-09. The router filters by keys and LLM_ALLOWED_MODELS.
import type { ModelInfo, ModelTier } from './types.js';

export const DEFAULT_CATALOG: ModelInfo[] = [
  { id: 'claude-opus-5', provider: 'anthropic', label: 'Claude Opus 5', tier: 'frontier', inputPerM: 5, outputPerM: 25, contextK: 1000, supportsEffort: true, thinking: 'adaptive', enabled: true },
  { id: 'claude-sonnet-5', provider: 'anthropic', label: 'Claude Sonnet 5', tier: 'strong', inputPerM: 2, outputPerM: 10, contextK: 1000, supportsEffort: true, thinking: 'adaptive', enabled: true },
  { id: 'claude-haiku-4-5', provider: 'anthropic', label: 'Claude Haiku 4.5', tier: 'fast', inputPerM: 1, outputPerM: 5, contextK: 200, supportsEffort: false, thinking: 'none', enabled: true },
  { id: 'gpt-5.6-sol', provider: 'openai', label: 'GPT-5.6 Sol', tier: 'frontier', inputPerM: 4, outputPerM: 20, contextK: 400, supportsEffort: true, thinking: 'none', enabled: true },
  { id: 'gpt-5.6-terra', provider: 'openai', label: 'GPT-5.6 Terra', tier: 'strong', inputPerM: 2, outputPerM: 12, contextK: 400, supportsEffort: true, thinking: 'none', enabled: true },
  { id: 'gpt-5.6-luna', provider: 'openai', label: 'GPT-5.6 Luna', tier: 'fast', inputPerM: 0.2, outputPerM: 1.2, contextK: 400, supportsEffort: true, thinking: 'none', enabled: true },
  { id: 'gpt-5-nano', provider: 'openai', label: 'GPT-5 Nano', tier: 'cheap', inputPerM: 0.05, outputPerM: 0.4, contextK: 400, supportsEffort: true, thinking: 'none', enabled: true },
  // OpenRouter prices and context windows below were read from the live catalogue
  // (GET https://openrouter.ai/api/v1/models) on 2026-09-18. They are a pre-key floor: with an
  // OPENROUTER_API_KEY set, `refreshOpenRouterPricing` overwrites them at boot, and the billed
  // `usage.cost` is authoritative per completion. Keeping them honest keeps the pre-flight
  // affordability gate and the buyer-facing runway projection honest before the first refresh.
  { id: 'deepseek/deepseek-chat-v3.1', provider: 'openrouter', label: 'DeepSeek V3.1', tier: 'cheap', inputPerM: 0.25, outputPerM: 0.95, cacheReadPerM: 0.13, contextK: 160, supportsEffort: false, thinking: 'none', enabled: true },
  { id: 'qwen/qwen3-235b-a22b-2507', provider: 'openrouter', label: 'Qwen3 235B', tier: 'cheap', inputPerM: 0.0875, outputPerM: 0.35, cacheReadPerM: 0.0175, contextK: 256, supportsEffort: false, thinking: 'none', enabled: true },
  { id: 'moonshotai/kimi-k2', provider: 'openrouter', label: 'Kimi K2', tier: 'cheap', inputPerM: 0.57, outputPerM: 2.3, contextK: 128, supportsEffort: false, thinking: 'none', enabled: true },
  { id: 'mock-fast', provider: 'mock', label: 'Mock Fast', tier: 'fast', inputPerM: 1, outputPerM: 5, contextK: 200, supportsEffort: true, thinking: 'none', enabled: true },
  { id: 'mock-strong', provider: 'mock', label: 'Mock Strong', tier: 'strong', inputPerM: 5, outputPerM: 25, contextK: 200, supportsEffort: true, thinking: 'none', enabled: true },
];

export const MODEL_TIERS: readonly ModelTier[] = ['frontier', 'strong', 'fast', 'cheap'];
export const TIER_LABELS: Record<ModelTier, string> = { frontier: 'FRONTIER', strong: 'STRONG', fast: 'FAST', cheap: 'CHEAP' };

export function findModel(id: string, catalog: readonly ModelInfo[] = DEFAULT_CATALOG): ModelInfo | undefined {
  return catalog.find((m) => m.id === id);
}

// Catalog sorted by id so prompts and hashes are stable across boots.
export function sortedCatalog(catalog: readonly ModelInfo[] = DEFAULT_CATALOG): ModelInfo[] {
  return [...catalog].sort((a, b) => a.id.localeCompare(b.id));
}

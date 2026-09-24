// Model catalog: DEFAULT_CATALOG plus env-added models, gated by provider keys and LLM_ALLOWED_MODELS.
// SPEC §6; AMENDMENTS A5 (OpenRouter boot refresh) and B14 (cheapest()).
import { DEFAULT_CATALOG, estimateMicro, type LlmMode, type ModelInfo, type ModelProvider } from '@vantra/shared';
import type { Config } from '../config.js';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_REFRESH_TIMEOUT_MS = 10_000;
// B14: cheapest() minimises the cost of this probe.
export const CHEAPEST_PROBE = { inTok: 3000, outTok: 600 } as const;

type KeyedProvider = Exclude<ModelProvider, 'mock'>;
const KEY_ENV: Record<KeyedProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

// Well-known models kept out of the default catalog for cost (SPEC §6). Listing the id in
// LLM_ALLOWED_MODELS adds one.
export const ENV_ADDABLE_MODELS: readonly ModelInfo[] = [
  // Fable 5.1 does NOT price cache reads at the usual 0.1x base input: they are $0.25/MTok flat,
  // where the default would charge $1.00/MTok. Left to the default every cached round on this model
  // would be billed to the agent at 4x what Anthropic actually charges.
  { id: 'claude-fable-5-1', provider: 'anthropic', label: 'Claude Fable 5.1', tier: 'frontier', inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25, contextK: 1000, supportsEffort: true, thinking: 'adaptive', enabled: true },
];

export interface CatalogEnv {
  mode: LlmMode;
  keys: Record<KeyedProvider, boolean>;
  allowed: string[];            // LLM_ALLOWED_MODELS entries: ids, env-addable ids or `provider:id:in:out[:ctxK]`
}

export interface Catalog {
  models: ModelInfo[];          // sorted by id; `enabled` already resolved
  disabled: Map<string, string>; // id → why it is disabled
}

export const catalogEnv = (config: Config): CatalogEnv => ({
  mode: config.llm.provider,
  keys: {
    anthropic: config.llm.anthropicApiKey !== null,
    openai: config.llm.openaiApiKey !== null,
    openrouter: config.llm.openrouterApiKey !== null,
  },
  allowed: config.llm.allowedModels,
});

const SPEC_RE = /^(anthropic|openai|openrouter):([^:\s]+):(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)(?::(\d+))?$/;

// Anthropic model families that reject `thinking: {type:'adaptive'}` and `output_config.effort`.
// Sending either to one of these is a 400 on the very first real call, so an env-added model whose
// id starts with one of these prefixes gets neither. Everything else on the Anthropic side (Opus 4.6+,
// Sonnet 4.6+, Fable, Mythos) takes both.
const ANTHROPIC_NO_ADAPTIVE_PREFIXES = ['claude-haiku', 'claude-3'] as const;

const anthropicCaps = (id: string): Pick<ModelInfo, 'supportsEffort' | 'thinking'> =>
  ANTHROPIC_NO_ADAPTIVE_PREFIXES.some((p) => id.startsWith(p))
    ? { supportsEffort: false, thinking: 'none' }
    : { supportsEffort: true, thinking: 'adaptive' };

// `provider:id:inputPerM:outputPerM[:contextK]` adds an arbitrary model with sensible defaults
// for the provider (Anthropic models get adaptive thinking + effort unless the family rejects them,
// OpenAI effort only, OpenRouter neither).
export function parseModelSpec(entry: string): ModelInfo | null {
  const m = SPEC_RE.exec(entry.trim());
  if (!m) return null;
  const provider = m[1] as KeyedProvider;
  const id = m[2]!;
  const caps = provider === 'anthropic'
    ? anthropicCaps(id)
    : { supportsEffort: provider === 'openai', thinking: 'none' as const };
  return {
    id,
    provider,
    label: id,
    tier: 'strong',
    inputPerM: Number(m[3]),
    outputPerM: Number(m[4]),
    contextK: m[5] === undefined ? 200 : Number(m[5]),
    ...caps,
    enabled: true,
  };
}

export function buildCatalog(env: CatalogEnv): Catalog {
  const models = DEFAULT_CATALOG.map(clone);
  const allowedIds = new Set(env.allowed.map((entry) => addAllowedEntry(models, entry)));
  const disabled = new Map<string, string>();
  for (const m of models) {
    const reason = disabledReason(m, env, allowedIds);
    m.enabled = reason === null;
    if (reason !== null) disabled.set(m.id, reason);
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  if (!models.some((m) => m.enabled)) {
    const detail = [...disabled].map(([id, why]) => `${id}: ${why}`).join('; ');
    throw new Error(`no enabled LLM models (${detail})`);
  }
  return { models, disabled };
}

// Returns the id the entry names; pushes env-added models into `models`.
function addAllowedEntry(models: ModelInfo[], entry: string): string {
  const id = entry.trim();
  if (models.some((m) => m.id === id)) return id;
  const addable = ENV_ADDABLE_MODELS.find((m) => m.id === id);
  const added = addable ? clone(addable) : parseModelSpec(id);
  if (!added) throw new Error(`LLM_ALLOWED_MODELS: unknown model "${id}" (use a catalog id or provider:id:inputPerM:outputPerM[:contextK])`);
  if (!models.some((m) => m.id === added.id)) models.push(added);
  return added.id;
}

function disabledReason(m: ModelInfo, env: CatalogEnv, allowedIds: Set<string>): string | null {
  // Mock mode serves only mock models and ignores LLM_ALLOWED_MODELS so `pnpm demo` cannot be misconfigured.
  if (env.mode === 'mock') return m.provider === 'mock' ? null : 'LLM_PROVIDER=mock';
  if (m.provider === 'mock') return 'mock models are only served when LLM_PROVIDER=mock';
  // x402 mode pays the gateway per call with USDC, so a model needs no provider key to be served.
  if (env.mode !== 'x402' && !env.keys[m.provider]) return `no ${KEY_ENV[m.provider]}`;
  if (allowedIds.size > 0 && !allowedIds.has(m.id)) return 'not in LLM_ALLOWED_MODELS';
  return null;
}

// Enabled model minimising estimateMicro(m, 3000, 600); ties resolve to the lowest id (B14).
export function cheapestOf(models: readonly ModelInfo[]): ModelInfo {
  let best: ModelInfo | null = null;
  let bestCost = Infinity;
  for (const m of [...models].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!m.enabled) continue;
    const cost = estimateMicro(m, CHEAPEST_PROBE.inTok, CHEAPEST_PROBE.outTok);
    if (cost < bestCost) { best = m; bestCost = cost; }
  }
  if (!best) throw new Error('cheapest(): no enabled models');
  return best;
}

interface OpenRouterPricing { prompt?: unknown; completion?: unknown; input_cache_read?: unknown; input_cache_write?: unknown }
interface OpenRouterModel { id?: unknown; pricing?: OpenRouterPricing }

// A5: OpenRouter prices are USD per token; the catalog is USD per 1M tokens. Mutates the catalog
// entries in place so every holder of a ModelInfo sees the refreshed price. Returns updated ids.
export async function refreshOpenRouterPricing(models: ModelInfo[], apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(OPENROUTER_MODELS_URL, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(OPENROUTER_REFRESH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${OPENROUTER_MODELS_URL}: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: OpenRouterModel[] };
  const pricing = new Map<string, OpenRouterPricing>();
  for (const m of body.data ?? []) if (typeof m.id === 'string') pricing.set(m.id, m.pricing ?? {});

  const updated: string[] = [];
  for (const m of models) {
    if (m.provider !== 'openrouter') continue;
    const p = pricing.get(m.id);
    if (!p) continue;
    const inputPerM = perMillion(p.prompt);
    const outputPerM = perMillion(p.completion);
    if (inputPerM === null || outputPerM === null) continue;
    m.inputPerM = inputPerM;
    m.outputPerM = outputPerM;
    const cacheRead = perMillion(p.input_cache_read);
    if (cacheRead !== null) m.cacheReadPerM = cacheRead;
    const cacheWrite = perMillion(p.input_cache_write);
    if (cacheWrite !== null) m.cacheWritePerM = cacheWrite;
    updated.push(m.id);
  }
  return updated;
}

// Per-token USD (string or number) → USD per 1M tokens, rounded to 6 decimals to drop float noise.
function perMillion(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1e6 * 1e6) / 1e6;
}

const clone = (m: ModelInfo): ModelInfo => ({ ...m });

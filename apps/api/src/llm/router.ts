// Provider-agnostic LLM router. SPEC §6, §8.1; AMENDMENTS A5 (pricing refresh), A6 (the router,
// not the SDK, owns retries: 3 attempts on 429/5xx/network with the identical body), B14 (cheapest).
import { estimateMicro, type Micro, type ModelInfo, type ModelProvider } from '@vantra/shared';
import type { Config } from '../config.js';
import type { LlmProvider, LlmRequest, LlmResponse, LlmRouter } from '../core/interfaces.js';
import { badRequest, errorMessage, internal } from '../lib/errors.js';
import type { Logger } from '../lib/log.js';
import { buildCatalog, catalogEnv, cheapestOf, refreshOpenRouterPricing, type Catalog } from './catalog.js';
import { LlmCallError } from './errors.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createMockProvider } from './providers/mock/index.js';
import { createOpenAiProvider } from './providers/openai.js';
import { createOpenRouterProvider } from './providers/openrouter.js';
import { createX402Provider, type EvmSignerResolver } from './providers/x402.js';

export const LLM_MAX_ATTEMPTS = 3;
export const LLM_RETRY_BASE_MS = 500;
export const LLM_RETRY_MIN_BUDGET_MS = 2_000;   // never start a retry with less step time left than this

export interface RouterOpts {
  config: Config;
  log: Logger;
  providers?: Partial<Record<ModelProvider, LlmProvider>>;              // test seam
  x402Provider?: LlmProvider;                                          // test seam for x402 mode
  resolveSigner?: EvmSignerResolver;                                   // per-agent EVM account, x402 mode only
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export function createRouter(opts: RouterOpts): LlmRouter {
  const { config, log } = opts;
  const catalog: Catalog = buildCatalog(catalogEnv(config));
  const cache = new Map<ModelProvider, LlmProvider>();
  const sleep = opts.sleep ?? delay;

  const enabled = (): ModelInfo[] => catalog.models.filter((m) => m.enabled);
  log.info({ models: enabled().map((m) => m.id), disabled: Object.fromEntries(catalog.disabled) }, 'llm catalog ready');

  let x402Provider: LlmProvider | undefined;
  // x402 mode routes EVERY model through one provider that pays the gateway per call from the agent's
  // own wallet; there is no per-provider key to select on. Built once, then cached.
  function x402(): LlmProvider {
    if (x402Provider) return x402Provider;
    if (opts.x402Provider) return (x402Provider = opts.x402Provider);
    const cfg = config.llm.x402;
    if (!cfg) throw internal('LLM_PROVIDER=x402 but X402_GATEWAY_URL produced no config');
    if (!opts.resolveSigner) throw internal('LLM_PROVIDER=x402 requires a per-agent signer resolver');
    x402Provider = createX402Provider({ gatewayUrl: cfg.gatewayUrl, maxPriceMicro: cfg.maxPriceMicro, resolveSigner: opts.resolveSigner, log });
    return x402Provider;
  }

  function providerFor(model: ModelInfo): LlmProvider {
    if (config.llm.provider === 'x402') return x402();
    const cached = cache.get(model.provider);
    if (cached) return cached;
    const created = opts.providers?.[model.provider] ?? construct(model.provider, config);
    cache.set(model.provider, created);
    return created;
  }

  function resolve(id: string): ModelInfo {
    const model = catalog.models.find((m) => m.id === id);
    if (!model) throw badRequest(`Unknown model "${id}"`, 'UNKNOWN_MODEL');
    if (!model.enabled) throw badRequest(`Model "${id}" is not available: ${catalog.disabled.get(id) ?? 'disabled'}`, 'UNKNOWN_MODEL');
    return model;
  }

  // A6: the router owns retries and sends the identical body each time, only shortening the deadline
  // it hands the provider. `remainingMs` is the step's budget, so a retry that cannot finish inside it
  // — or a backoff that would eat what is left — is not attempted at all.
  async function complete(req: LlmRequest): Promise<LlmResponse> {
    const model = resolve(req.model);
    const provider = providerFor(model);
    const startedAt = Date.now();
    const budgetMs = req.remainingMs;
    const leftMs = (): number | undefined => (budgetMs === undefined ? undefined : budgetMs - (Date.now() - startedAt));

    let lastError: unknown;
    for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt++) {
      const remainingMs = leftMs();
      try {
        const res = await provider.complete(remainingMs === undefined ? req : { ...req, remainingMs }, model);
        warnOnCacheMiss(log, req, res, model);
        warnOnUnmeteredUsage(log, req, res, model);
        return res;
      } catch (e) {
        lastError = e;
        const retryable = e instanceof LlmCallError && e.retryable;
        if (!retryable || attempt === LLM_MAX_ATTEMPTS || req.signal?.aborted === true) break;
        const waitMs = LLM_RETRY_BASE_MS * 2 ** (attempt - 1);
        const afterBackoff = leftMs();
        if (afterBackoff !== undefined && afterBackoff - waitMs < LLM_RETRY_MIN_BUDGET_MS) {
          log.warn({ agentId: req.agentId, model: model.id, attempt, remainingMs: afterBackoff }, 'llm call failed; no step budget left to retry');
          break;
        }
        log.warn({ agentId: req.agentId, model: model.id, attempt, waitMs, err: errorMessage(e) }, 'llm call failed; retrying');
        await sleep(waitMs, req.signal);
      }
    }
    throw lastError ?? internal(`llm completion failed for ${model.id}`);
  }

  async function refreshPricing(): Promise<void> {
    const apiKey = config.llm.openrouterApiKey;
    if (!apiKey || !enabled().some((m) => m.provider === 'openrouter')) return;
    try {
      const updated = await refreshOpenRouterPricing(catalog.models, apiKey, opts.fetchImpl ?? fetch);
      log.info({ updated }, 'openrouter pricing refreshed');
    } catch (e) {
      log.warn({ err: errorMessage(e) }, 'openrouter pricing refresh failed; using catalog prices');
    }
  }

  return {
    mode: config.llm.provider,
    models: enabled,
    resolve,
    complete,
    cheapest: () => cheapestOf(catalog.models),
    estimateMicro: (model: ModelInfo, inTok: number, outTok: number): Micro => estimateMicro(model, inTok, outTok),
    refreshPricing,
  };
}

function construct(provider: ModelProvider, config: Config): LlmProvider {
  switch (provider) {
    case 'mock': return createMockProvider();
    case 'anthropic': return createAnthropicProvider({ apiKey: requireKey(config.llm.anthropicApiKey, 'ANTHROPIC_API_KEY') });
    case 'openai': return createOpenAiProvider({ apiKey: requireKey(config.llm.openaiApiKey, 'OPENAI_API_KEY') });
    case 'openrouter': return createOpenRouterProvider({ apiKey: requireKey(config.llm.openrouterApiKey, 'OPENROUTER_API_KEY') });
  }
}

function requireKey(key: string | null, name: string): string {
  if (!key) throw internal(`${name} is required for this model but is not set`);
  return key;
}

// A6: the conversation tail is cached with an ephemeral breakpoint, so any round after the first
// that reads nothing back from cache is money burned. Loud enough to notice in the logs, cheap
// enough to ignore when a provider genuinely has no cache.
function warnOnCacheMiss(log: Logger, req: LlmRequest, res: LlmResponse, model: ModelInfo): void {
  if (model.provider !== 'anthropic') return;
  if (res.usage.cacheReadTokens > 0) return;
  if (!req.messages.some((m) => m.role === 'assistant')) return;
  log.warn(
    { agentId: req.agentId, model: model.id, inputTokens: res.usage.inputTokens },
    'anthropic prompt cache miss: the whole conversation was re-read at full price',
  );
}

// A completion the provider could not meter is billed to the agent at zero, so the platform pays for
// it out of its own pocket and no one finds out. Every real provider returns a usage block on a
// non-streaming call; if one does not, that is an anomaly worth a line in the log rather than silence.
function warnOnUnmeteredUsage(log: Logger, req: LlmRequest, res: LlmResponse, model: ModelInfo): void {
  if (model.provider === 'mock') return;
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costMicro } = res.usage;
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens > 0 && costMicro > 0) return;
  log.warn(
    { agentId: req.agentId, model: model.id, usage: res.usage },
    'llm response carried no usable usage accounting: this completion was billed to the agent at zero',
  );
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

// Provider-agnostic router (anthropic | openai | openrouter | mock | x402). SPEC §6, §8.1; AMENDMENTS §A.
import type { Config } from '../config.js';
import type { LlmRouter } from '../core/interfaces.js';
import type { Logger } from '../lib/log.js';
import { createRouter } from './router.js';
import type { EvmSignerResolver } from './providers/x402.js';

export function createLlmRouter(config: Config, log: Logger, resolveSigner?: EvmSignerResolver): LlmRouter {
  return createRouter({ config, log: log.child({ module: 'llm' }), ...(resolveSigner ? { resolveSigner } : {}) });
}

export { buildCatalog, catalogEnv, cheapestOf, refreshOpenRouterPricing } from './catalog.js';
export { LlmCallError } from './errors.js';
export { toStrictSchema } from './schema.js';
export { createRouter, LLM_MAX_ATTEMPTS, LLM_RETRY_BASE_MS } from './router.js';

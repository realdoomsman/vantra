// Server-side quoting (SPEC-V2 §5.1). The arithmetic itself lives in @vantra/shared so the browser
// and the server cannot disagree; this file only resolves the live model catalog, the configured fee
// and the dev heartbeat override, then turns `runwayDays` into a date with the container clock.
import {
  DAY_MS, MIN_PROJECTED_LIFE_DAYS, QUOTE_IN_TOKENS, QUOTE_OUT_TOKENS, TIERS, estimateMicro, quoteFor,
  resolveTierModel, tierById, tierForMicro,
  type AgentTier, type Micro, type ModelInfo, type Pace, type PurchaseQuote, type TiersResponse,
} from '@vantra/shared';
import type { Clock, LlmRouter } from '../core/interfaces.js';
import type { Config } from '../config.js';

export type QuoteDeps = { config: Config; llm: LlmRouter; clock: Clock };

export type ServerQuote = PurchaseQuote & { diesOn: string | null };

export interface QuoteOptions {
  amountMicro: Micro;
  pace?: Pace;
  tier?: AgentTier;
  feeBps?: number;                 // defaults to the configured founder fee
  modelId?: string;                // a model already chosen for this purchase (fulfilment recorded it)
  heartbeatMin?: number;           // a heartbeat already resolved for this purchase
}

/** The model a tier gets from the live router, with the router's own cheapest model as the floor. */
export function modelForTier(deps: QuoteDeps, tier: AgentTier, modelId?: string): ModelInfo {
  const models = deps.llm.models();
  const named = modelId ? models.find((m) => m.id === modelId) : undefined;
  return named ?? resolveTierModel(tier, models) ?? deps.llm.cheapest();
}

/** SPEC-V2 §2.1 end to end: fee, tier, model, heartbeat, burn, days of life and the date of death. */
export function quotePurchase(deps: QuoteDeps, opts: QuoteOptions): ServerQuote {
  const tier = opts.tier ?? tierForMicro(opts.amountMicro);
  const model = modelForTier(deps, tier, opts.modelId);
  // A heartbeat already resolved for this purchase wins; otherwise the dev-only override does.
  const override = opts.heartbeatMin ?? deps.config.economy.heartbeatOverrideMin ?? undefined;
  const quote = quoteFor({
    amountMicro: opts.amountMicro,
    feeBps: opts.feeBps ?? deps.config.economy.founderFeeBps,
    model,
    pace: opts.pace ?? 'steady',
    ...(override === undefined ? {} : { heartbeatOverrideMin: override }),
    tier,
  });
  return { ...quote, diesOn: diesOn(deps, quote.runwayDays) };
}

export function diesOn(deps: QuoteDeps, runwayDays: number | null): string | null {
  if (runwayDays === null || !Number.isFinite(runwayDays)) return null;
  return new Date(deps.clock.now().getTime() + runwayDays * DAY_MS).toISOString();
}

/** GET /api/tiers: the table plus the model each tier actually resolves to right now. */
export function tiersResponse(deps: QuoteDeps): TiersResponse {
  const models = deps.llm.models();
  return {
    tiers: TIERS.map((t) => {
      const model = resolveTierModel(t, models) ?? deps.llm.cheapest();
      return {
        ...t,
        enabledTools: [...t.enabledTools],
        modelId: model.id,
        modelLabel: model.label,
        stepCostMicro: estimateMicro(model, QUOTE_IN_TOKENS, QUOTE_OUT_TOKENS),
      };
    }),
    feeBps: deps.config.economy.founderFeeBps,
    minMicro: deps.config.economy.minPurchaseMicro,
    maxMicro: deps.config.economy.maxPurchaseMicro,
    minProjectedLifeDays: MIN_PROJECTED_LIFE_DAYS,
  };
}

/** The tier a stored row is running under, falling back to the tier quoted at checkout. */
export function tierOfRow(row: { tier: string | null; quotedTier: string }): AgentTier {
  return tierById(row.tier ?? '') ?? tierById(row.quotedTier) ?? TIERS[0]!;
}

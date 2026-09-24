// Agent tiers and purchase quoting. SPEC-V2 §2 + §3.1.
//
// Everything here is pure, so the browser quote and the server quote are the same code. Import
// direction is types.ts ← constants.ts ← tiers.ts: the scalars live in constants.ts precisely so
// this module can import them without creating a cycle.
//
// The two numbers that matter and how they relate:
//   `heartbeatMin`   the FASTEST heartbeat a tier may run at (PRIME's 30 min is the fastest of all)
//   `targetLifeDays` the guaranteed-minimum projected life, which is what actually derives the
//                    heartbeat: walk the ladder from the tier's floor and take the first (fastest)
//                    rung whose projection still clears the target. More money therefore buys a
//                    faster heartbeat within a tier, and each tier's floor lives longer than the
//                    floor below it.
import type { Effort, Micro, ModelInfo, ModelTier, ToolName } from './types.js';
import {
  ALL_TOOLS, MIN_PURCHASE_MICRO, QUOTE_IN_TOKENS, QUOTE_OUT_TOKENS, RENT_PER_HOUR_MICRO,
} from './constants.js';
import { bpsOf, estimateMicro, type ModelPricing } from './money.js';

export type TierId = 'SPARK' | 'SCOUT' | 'OPERATOR' | 'PRIME';
export type Pace = 'patient' | 'steady' | 'eager';

export const PACES: readonly Pace[] = ['patient', 'steady', 'eager'];
export const isPace = (s: string): s is Pace => (PACES as readonly string[]).includes(s);

export interface AgentTier {
  id: TierId;
  label: string;
  minUsd: number;
  minMicro: Micro;
  modelId: string;
  modelTier: ModelTier;
  effort: Effort;
  enabledTools: ToolName[];
  heartbeatMin: number;        // the FASTEST heartbeat this tier may run at
  targetLifeDays: number;      // the guaranteed-minimum projected life used to derive the heartbeat
  blurb: string;
}

const T_CORE: ToolName[] = [
  'fetch_url', 'wallet', 'set_model', 'set_effort', 'sleep', 'remember', 'forget',
  'update_project', 'post_update', 'message_owner', 'publish_strategy',
  'list_bounties', 'claim_bounty', 'submit_bounty', 'list_services', 'trade',
];

export const TIER_TOOLS: Record<TierId, ToolName[]> = {
  SPARK: [...T_CORE],
  SCOUT: [...T_CORE, 'web_search'],
  OPERATOR: [...T_CORE, 'web_search', 'bash', 'write_file', 'read_file', 'list_files',
    'deploy_site', 'create_service', 'update_service', 'call_service'],
  PRIME: [...ALL_TOOLS],            // adds post_bounty + review_submission: PRIME can hire
};

export const TIERS: readonly AgentTier[] = [
  {
    id: 'SPARK', label: 'SPARK', minUsd: 10, minMicro: MIN_PURCHASE_MICRO,
    modelId: 'gpt-5-nano', modelTier: 'cheap', effort: 'low',
    enabledTools: TIER_TOOLS.SPARK, heartbeatMin: 120, targetLifeDays: 60,
    blurb: 'A mind and a wallet. Cheapest model, no web search, no sandbox. It can read a URL, keep '
      + 'notes, work the bounty board and talk to you. The honest $10 experiment.',
  },
  {
    id: 'SCOUT', label: 'SCOUT', minUsd: 25, minMicro: 25_000_000,
    modelId: 'claude-haiku-4-5', modelTier: 'fast', effort: 'medium',
    enabledTools: TIER_TOOLS.SCOUT, heartbeatMin: 90, targetLifeDays: 75,
    blurb: 'Adds web search and a sharper model. It can go and find out whether anyone wants what it '
      + 'is thinking of building.',
  },
  {
    id: 'OPERATOR', label: 'OPERATOR', minUsd: 50, minMicro: 50_000_000,
    modelId: 'claude-sonnet-5', modelTier: 'strong', effort: 'medium',
    enabledTools: TIER_TOOLS.OPERATOR, heartbeatMin: 60, targetLifeDays: 90,
    blurb: 'A strong model plus the full sandbox: write files, run code, deploy a site, publish a '
      + 'paid service. This is the cheapest tier that can actually ship a product.',
  },
  {
    id: 'PRIME', label: 'PRIME', minUsd: 100, minMicro: 100_000_000,
    modelId: 'claude-opus-5', modelTier: 'frontier', effort: 'high',
    enabledTools: TIER_TOOLS.PRIME, heartbeatMin: 30, targetLifeDays: 120,
    blurb: 'The best model, every tool, and the fastest heartbeat the money will buy. It can also '
      + 'post bounties and hire other agents.',
  },
];

export const TIER_IDS: readonly TierId[] = TIERS.map((t) => t.id);
export const HEARTBEAT_LADDER: readonly number[] = [30, 45, 60, 90, 120, 180, 240, 360, 720, 1440];
const MODEL_CLASS_LADDER: readonly ModelTier[] = ['frontier', 'strong', 'fast', 'cheap'];

export const isTierId = (s: string): s is TierId => (TIER_IDS as readonly string[]).includes(s);
export const tierById = (id: string): AgentTier | undefined => TIERS.find((t) => t.id === id);

/** Highest tier whose floor the amount reaches; clamps to TIERS[0] below the lowest floor. */
export function tierForMicro(amountMicro: Micro): AgentTier {
  let found = TIERS[0]!;
  for (const t of TIERS) if (amountMicro >= t.minMicro) found = t;
  return found;
}

/** The tier above this one, or null for the open-ended top tier. */
export function nextTierAfter(tier: AgentTier): AgentTier | null {
  const i = TIERS.findIndex((t) => t.id === tier.id);
  return i >= 0 && i + 1 < TIERS.length ? TIERS[i + 1]! : null;
}

/** One decimal, the same rounding the burn projection uses. */
export const round1 = (x: number): number => Math.round(x * 10) / 10;

const quoteStepCost = (model: ModelPricing): Micro => estimateMicro(model, QUOTE_IN_TOKENS, QUOTE_OUT_TOKENS);

/** SPEC-V2 §2.3. `models` is the live router catalog; null means "caller falls back to cheapest()". */
export function resolveTierModel(tier: AgentTier, models: readonly ModelInfo[]): ModelInfo | null {
  const usable = models.filter((m) => m.enabled);
  if (usable.length === 0) return null;
  const exact = usable.find((m) => m.id === tier.modelId);
  if (exact) return exact;

  const cheapestOf = (cls: ModelTier): ModelInfo | null => {
    const inClass = usable.filter((m) => m.tier === cls);
    if (inClass.length === 0) return null;
    return inClass.reduce((best, m) => (quoteStepCost(m) < quoteStepCost(best) ? m : best));
  };

  const start = MODEL_CLASS_LADDER.indexOf(tier.modelTier);
  const same = start >= 0 ? cheapestOf(tier.modelTier) : null;
  if (same) return same;
  for (let i = start + 1; i < MODEL_CLASS_LADDER.length; i += 1) {   // walk DOWN (cheaper)
    const hit = cheapestOf(MODEL_CLASS_LADDER[i]!);
    if (hit) return hit;
  }
  for (let i = start - 1; i >= 0; i -= 1) {                          // then UP (dearer)
    const hit = cheapestOf(MODEL_CLASS_LADDER[i]!);
    if (hit) return hit;
  }
  return null;
}

export const rentPerDayMicro = (): Micro => RENT_PER_HOUR_MICRO * 24;

/** Burn per day at a given heartbeat: rent plus one quote-sized step per beat. Hosting is 0 at birth. */
export function burnPerDayAt(heartbeatMin: number, model: ModelPricing): Micro {
  const beats = Math.max(1, heartbeatMin);
  const stepsPerDay = 1440 / beats;
  return Math.round(rentPerDayMicro() + stepsPerDay * quoteStepCost(model));
}

export function runwayDaysAt(heartbeatMin: number, fundingMicro: Micro, model: ModelPricing): number {
  const burn = burnPerDayAt(heartbeatMin, model);
  return burn > 0 ? round1(fundingMicro / burn) : 0;
}

/** The fastest rung the tier allows that still clears `targetLifeDays`; 1440 when none does. */
export function deriveHeartbeat(tier: AgentTier, fundingMicro: Micro, model: ModelPricing): number {
  for (const h of HEARTBEAT_LADDER) {
    if (h < tier.heartbeatMin) continue;
    if (runwayDaysAt(h, fundingMicro, model) >= tier.targetLifeDays) return h;
  }
  return HEARTBEAT_LADDER[HEARTBEAT_LADDER.length - 1]!;
}

/** Pace trades thinking for time. It never goes faster than the tier's floor. */
export function paceHeartbeat(tier: AgentTier, fundingMicro: Micro, model: ModelPricing, pace: Pace): number {
  if (pace === 'eager') return tier.heartbeatMin;
  const steady = deriveHeartbeat(tier, fundingMicro, model);
  if (pace === 'steady') return steady;
  const i = HEARTBEAT_LADDER.indexOf(steady);
  const slower = i < 0 ? steady : HEARTBEAT_LADDER[Math.min(i + 2, HEARTBEAT_LADDER.length - 1)]!;
  return Math.max(slower, tier.heartbeatMin);
}

export interface QuoteInput {
  amountMicro: Micro;
  feeBps: number;
  model: ModelPricing & { id: string };
  pace?: Pace;                       // default 'steady'
  heartbeatOverrideMin?: number;     // HEARTBEAT_OVERRIDE_MIN, dev only
  tier?: AgentTier;                  // default tierForMicro(amountMicro)
}

export interface PurchaseQuote {
  amountMicro: Micro; feeBps: number; feeMicro: Micro; fundingMicro: Micro;
  tierId: TierId; tierLabel: string;
  modelId: string; effort: Effort; enabledTools: ToolName[];
  heartbeatMin: number; stepsPerDay: number;
  stepCostMicro: Micro; rentPerDayMicro: Micro; burnPerDayMicro: Micro;
  runwayDays: number | null;
  pace: Pace;
  nextTier: { id: TierId; minMicro: Micro; addMicro: Micro } | null;   // what one more step up costs
}

/** SPEC-V2 §2.1. Pure: the caller turns `runwayDays` into a `diesOn` with its own clock. */
export function quoteFor(input: QuoteInput): PurchaseQuote {
  const amountMicro = Math.round(input.amountMicro);
  const feeMicro = bpsOf(amountMicro, input.feeBps);
  const fundingMicro = amountMicro - feeMicro;
  const tier = input.tier ?? tierForMicro(amountMicro);
  const pace: Pace = input.pace ?? 'steady';
  const override = input.heartbeatOverrideMin;
  const heartbeatMin = override && override > 0
    ? override
    : paceHeartbeat(tier, fundingMicro, input.model, pace);
  const stepsPerDay = 1440 / Math.max(1, heartbeatMin);
  const stepCostMicro = quoteStepCost(input.model);
  const rentDay = rentPerDayMicro();
  const burnPerDayMicro = Math.round(rentDay + stepsPerDay * stepCostMicro);
  const next = nextTierAfter(tier);
  return {
    amountMicro, feeBps: input.feeBps, feeMicro, fundingMicro,
    tierId: tier.id, tierLabel: tier.label,
    modelId: input.model.id, effort: tier.effort, enabledTools: [...tier.enabledTools],
    heartbeatMin, stepsPerDay,
    stepCostMicro, rentPerDayMicro: rentDay, burnPerDayMicro,
    runwayDays: burnPerDayMicro > 0 ? round1(fundingMicro / burnPerDayMicro) : null,
    pace,
    nextTier: next
      ? { id: next.id, minMicro: next.minMicro, addMicro: Math.max(0, next.minMicro - amountMicro) }
      : null,
  };
}

/** True when the amount is inside the honesty window below the next tier's floor (SPEC-V2 §2.5). */
export const TIER_BOUNDARY_WARN_FRACTION = 0.2;
export function nearNextTier(amountMicro: Micro): boolean {
  const next = nextTierAfter(tierForMicro(amountMicro));
  if (!next) return false;
  return amountMicro >= next.minMicro * (1 - TIER_BOUNDARY_WARN_FRACTION) && amountMicro < next.minMicro;
}

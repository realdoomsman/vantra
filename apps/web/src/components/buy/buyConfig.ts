// Static buy-form vocabulary: directive presets, tool cost labels, pace copy and the
// log-scale amount slider. SPEC-V2 §9.4. Everything money-shaped comes from @vantra/shared's
// `quoteFor` so the browser and the server run the same arithmetic.
import type { Micro, ModelInfo, Pace, TierId, ToolName } from '@vantra/shared';
import { MAX_PURCHASE_MICRO, MIN_PURCHASE_MICRO, TOOL_COST_MICRO, fmtUsd, usd } from '@vantra/shared';

/** One-phrase capability summary per tier, for the ledger's TIER row. */
export const TIER_CAPS: Record<TierId, string> = {
  SPARK: 'no web search, no sandbox',
  SCOUT: 'web search',
  OPERATOR: 'web search + sandbox + deploy',
  PRIME: 'every tool · can hire other agents',
};

export interface DirectivePreset {
  label: string;
  text: string;
}

/** Three starting directives (carried over from v1's spawn step 2). */
export const DIRECTIVE_PRESETS: DirectivePreset[] = [
  {
    label: 'SELL A SERVICE',
    text:
      'Find one small, boring job people already pay for, build it as a JSON service other agents and humans can call, ' +
      'price it so a single call covers more than a step of your inference, and keep improving the one that sells.',
  },
  {
    label: 'BUILD & PUBLISH',
    text:
      'Pick a narrow audience, deploy a genuinely useful static site for them, and turn attention into paid work: ' +
      'a service endpoint, a bounty you can claim, or a product someone sends USDC for. Cut anything that does not earn.',
  },
  {
    label: 'WORK THE BOUNTY BOARD',
    text:
      'Survive on bounties. Read the board every heartbeat, claim only work you can finish before the deadline, ' +
      'submit carefully, and bank enough surplus to keep paying rent on slow days.',
  },
];

const TOOL_COST_LABEL: Partial<Record<ToolName, string>> = {
  web_search: fmtUsd(TOOL_COST_MICRO.web_search ?? 0),
  fetch_url: fmtUsd(TOOL_COST_MICRO.fetch_url ?? 0),
  deploy_site: fmtUsd(TOOL_COST_MICRO.deploy_site ?? 0),
  bash: `from ${fmtUsd(TOOL_COST_MICRO.bash_min ?? 0)} + cpu`,
  call_service: "seller's price",
  post_bounty: 'reward escrowed',
};

/** Per-call cost shown under each tool card; free tools say so. */
export const toolCostLabel = (tool: ToolName): string => TOOL_COST_LABEL[tool] ?? 'FREE';

export const toolLabel = (tool: ToolName): string => tool.replace(/_/g, ' ');

export const PACE_LABEL: Record<Pace, string> = { patient: 'PATIENT', steady: 'STEADY', eager: 'EAGER' };

export const PACE_NOTE: Record<Pace, string> = {
  patient: 'Thinks less often and lives longer. Good for an agent whose plan is slow to pay off.',
  steady: 'The heartbeat the tier was tuned for: the fastest pace that still clears its target lifespan.',
  eager: 'The fastest heartbeat this tier allows. More chances to earn, a shorter life if it earns nothing.',
};

/** Quick-pick amounts: one per tier floor. */
export const AMOUNT_CHIPS: readonly number[] = [10, 25, 50, 100];

/** Slider range, log scale so the cheap end has room (SPEC-V2 §9.4). */
export const SLIDER_MIN_USD = 10;
export const SLIDER_MAX_USD = 500;
const LOG_MIN = Math.log(SLIDER_MIN_USD);
const LOG_MAX = Math.log(SLIDER_MAX_USD);
export const SLIDER_STEPS = 1000;

/** Slider position (0…SLIDER_STEPS) → whole dollars. */
export function sliderToUsd(pos: number): number {
  const t = Math.min(1, Math.max(0, pos / SLIDER_STEPS));
  return Math.round(Math.exp(LOG_MIN + t * (LOG_MAX - LOG_MIN)));
}

/** Whole dollars → slider position, clamped to the track. */
export function usdToSlider(dollars: number): number {
  const clamped = Math.min(SLIDER_MAX_USD, Math.max(SLIDER_MIN_USD, dollars));
  return Math.round(((Math.log(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * SLIDER_STEPS);
}

/** Dollar text from a buyer's input → micro-dollars, or null when unusable. */
export function parseAmount(text: string): Micro | null {
  const n = Number(text.trim().replace(/[$,]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return usd(n);
}

/** Plain dollars for the amount box, without the '$'. */
export const amountText = (micro: Micro): string => (micro / 1_000_000).toFixed(2).replace(/\.00$/, '');

export const clampPurchase = (micro: Micro): Micro =>
  Math.min(MAX_PURCHASE_MICRO, Math.max(MIN_PURCHASE_MICRO, Math.round(micro)));

export const heartbeatLabel = (min: number): string =>
  min >= 1440 ? `${Math.round(min / 1440)}D` : min >= 60 && min % 60 === 0 ? `${min / 60}H` : `${min}M`;

/** How often the agent thinks, as plain words: "every 120 min · 12 times a day". */
export function thinksLabel(heartbeatMin: number, stepsPerDay: number): string {
  const perDay = stepsPerDay >= 1 ? `${Math.round(stepsPerDay)} times a day` : `${(stepsPerDay * 7).toFixed(1)} times a week`;
  return `every ${heartbeatMin} min · ${perDay}`;
}

export const modelLabelOf = (models: ModelInfo[], id: string): string => models.find((m) => m.id === id)?.label ?? id;

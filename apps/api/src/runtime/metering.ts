// Pre-flight budgeting for every completion (AMENDMENTS B10, SPEC-V2 §7.2). A step may never spend
// more than its step cap minus STEP_SUMMARY_RESERVE_MICRO on its rounds; the reserve keeps the closing
// completion affordable even after a cap abort.
//
// v2 makes the cap RELATIVE to the treasury: a flat $0.50 ceiling let twenty bad steps empty a $9
// agent, which is most of a purchase. The cap is now 2% of the treasury, floored at the cost of one
// minimal heartbeat (so a poor agent can always still think) and ceilinged at MAX_STEP_COST_MICRO.
import {
  LLM_MAX_TOKENS_MIN, MAX_STEP_COST_MICRO, STEP_COST_TREASURY_BPS, STEP_SUMMARY_RESERVE_MICRO,
  bpsOf, estimateMicro, priceUsage, type Micro, type ModelInfo,
} from '@vantra/shared';
import type { LlmUsage } from '../core/interfaces.js';

export const CLOSING_MIN_TOKENS = 64;        // a closing completion may shrink below the normal 1024 floor
export const CHARS_PER_TOKEN = 4;

export const tokensOf = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

export interface PreflightInput {
  model: ModelInfo;
  ctxTokens: number;              // previous usage total + new tool-result tokens (round 1: system+tools+STATUS)
  desiredMaxTokens: number;
  treasuryMicro: Micro;
  minStepMicro: Micro;            // one minimal heartbeat: cheapest model + this heartbeat's fixed cost
  stepCostMicro: Micro;           // already spent inside this step
  rounds: number;
  closing: boolean;               // closing / last-words completion: runs from the reserve, tools off
}
export type Preflight =
  | { action: 'run'; maxTokens: number; estMicro: Micro; budgetMicro: Micro; shrunk: boolean }
  | { action: 'close'; budgetMicro: Micro; reason: string }
  | { action: 'die'; budgetMicro: Micro; reason: string };

export type BudgetInput = Pick<PreflightInput, 'treasuryMicro' | 'stepCostMicro' | 'closing' | 'minStepMicro'>;

// The most one heartbeat may cost (SPEC-V2 §7.2).
export function stepCapOf(treasuryMicro: Micro, minStepMicro: Micro): Micro {
  return Math.min(MAX_STEP_COST_MICRO, Math.max(minStepMicro, bpsOf(treasuryMicro, STEP_COST_TREASURY_BPS)));
}

export function budgetFor(i: BudgetInput): Micro {
  if (i.closing) return Math.min(i.treasuryMicro, STEP_SUMMARY_RESERVE_MICRO);
  const cap = stepCapOf(i.treasuryMicro, i.minStepMicro);
  // Holding back the full reserve out of a cap that is itself only one minimal step wide would leave
  // nothing to think with, so the reserve never eats into the floor the cap guarantees.
  const reserve = Math.min(STEP_SUMMARY_RESERVE_MICRO, Math.max(0, cap - i.minStepMicro));
  return Math.min(i.treasuryMicro, cap - reserve - i.stepCostMicro);
}

// Prices in the catalog are USD per 1M tokens and money is micro-dollars, so `tokens × perM` is
// already the cost in micro-dollars and the affordable output length is `budget ÷ outputPerM`.
export function preflight(i: PreflightInput): Preflight {
  const budgetMicro = budgetFor(i);
  const estMicro = estimateMicro(i.model, i.ctxTokens, i.desiredMaxTokens);
  if (estMicro <= budgetMicro) {
    return { action: 'run', maxTokens: i.desiredMaxTokens, estMicro, budgetMicro, shrunk: false };
  }
  const floor = i.closing ? CLOSING_MIN_TOKENS : LLM_MAX_TOKENS_MIN;
  const inputMicro = estimateMicro(i.model, i.ctxTokens, 0);
  const affordable = Math.floor((budgetMicro - inputMicro) / i.model.outputPerM);
  if (affordable >= floor) {
    const maxTokens = Math.min(affordable, i.desiredMaxTokens);
    return { action: 'run', maxTokens, estMicro: estimateMicro(i.model, i.ctxTokens, maxTokens), budgetMicro, shrunk: true };
  }
  const reason = `needs ${estMicro} micro for ${i.ctxTokens} context tokens, budget is ${budgetMicro}`;
  return i.rounds > 0 && !i.closing
    ? { action: 'close', budgetMicro, reason }
    : { action: 'die', budgetMicro, reason };
}

// Providers price their own usage; priceUsage is the fallback for any that do not.
export const usageCost = (model: ModelInfo, usage: LlmUsage): Micro =>
  usage.costMicro > 0 ? usage.costMicro : priceUsage(model, usage);

// Tokens the next request will carry: what the model just billed us plus the new tool results (B10).
export const carriedTokens = (usage: LlmUsage, newToolResultChars: number): number =>
  usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens + tokensOf(newToolResultChars);

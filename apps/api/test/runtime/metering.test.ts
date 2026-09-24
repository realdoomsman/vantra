// Pre-flight budgeting (AMENDMENTS B10, SPEC-V2 §7.2). Prices are USD per 1M tokens and money is
// micro-dollars, so one output token of a $5/1M model costs exactly 5 micro-dollars.
//
// v2 replaced the flat $0.50 step ceiling with one relative to the treasury: 2% of it, floored at the
// cost of one minimal heartbeat and capped at MAX_STEP_COST_MICRO. The cases below pin both ends of
// that — a rich agent still gets the old budget, and a poor one can still afford to think.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CATALOG, MAX_STEP_COST_MICRO, STEP_COST_TREASURY_BPS, STEP_SUMMARY_RESERVE_MICRO, type ModelInfo,
} from '@vantra/shared';
import { budgetFor, carriedTokens, preflight, stepCapOf, tokensOf, usageCost } from '../../src/runtime/metering.js';

const model = DEFAULT_CATALOG.find((m) => m.id === 'mock-fast')! as ModelInfo;   // in $1/1M, out $5/1M
const MIN_STEP = 16_000;              // one minimal heartbeat: cheapest completion + an hour of rent
const base = {
  model, ctxTokens: 10_000, treasuryMicro: 10_000_000, minStepMicro: MIN_STEP, stepCostMicro: 0,
  rounds: 1, closing: false,
};

describe('runtime/metering', () => {
  it('caps one step at 2% of the treasury, never above the absolute ceiling', () => {
    expect(stepCapOf(10_000_000, MIN_STEP)).toBe(200_000);                       // 2% of $10
    expect(stepCapOf(500_000_000, MIN_STEP)).toBe(MAX_STEP_COST_MICRO);          // $500 → clamped to $0.50
    expect(STEP_COST_TREASURY_BPS).toBe(200);
  });

  it('never lets the cap fall below one minimal heartbeat', () => {
    expect(stepCapOf(300_000, MIN_STEP)).toBe(MIN_STEP);                         // 2% would be $0.006
    expect(stepCapOf(0, MIN_STEP)).toBe(MIN_STEP);
  });

  // This is the point of the change: twenty capped steps used to be $10 and can now only ever be a
  // third of the treasury, whatever the agent does.
  it('leaves a treasury alive after twenty steps that each spend the whole cap', () => {
    let treasury = 9_000_000;
    for (let i = 0; i < 20; i++) treasury -= stepCapOf(treasury, MIN_STEP);
    expect(treasury).toBeGreaterThan(9_000_000 * 0.6);
  });

  it('keeps the step cap minus the summary reserve available to the rounds', () => {
    expect(budgetFor({ treasuryMicro: 10_000_000, stepCostMicro: 0, closing: false, minStepMicro: MIN_STEP })).toBe(150_000);
    expect(budgetFor({ treasuryMicro: 10_000_000, stepCostMicro: 100_000, closing: false, minStepMicro: MIN_STEP })).toBe(50_000);
    // A rich agent is on the absolute ceiling, so it sees exactly the v1 budget.
    expect(budgetFor({ treasuryMicro: 500_000_000, stepCostMicro: 0, closing: false, minStepMicro: MIN_STEP }))
      .toBe(MAX_STEP_COST_MICRO - STEP_SUMMARY_RESERVE_MICRO);
    expect(budgetFor({ treasuryMicro: 10_000_000, stepCostMicro: 400_000, closing: true, minStepMicro: MIN_STEP }))
      .toBe(STEP_SUMMARY_RESERVE_MICRO);
  });

  // The reserve is held back out of the cap, not out of the floor: holding back $0.05 from a cap that
  // is itself one minimal step wide would leave a poor agent nothing to think with.
  it('does not let the summary reserve eat the floor a poor agent stands on', () => {
    expect(budgetFor({ treasuryMicro: 300_000, stepCostMicro: 0, closing: false, minStepMicro: MIN_STEP })).toBe(MIN_STEP);
    expect(budgetFor({ treasuryMicro: 7_000, stepCostMicro: 0, closing: false, minStepMicro: MIN_STEP })).toBe(7_000);
  });

  it('runs at the requested size when it fits', () => {
    const result = preflight({ ...base, desiredMaxTokens: 16_000 });
    expect(result).toMatchObject({ action: 'run', maxTokens: 16_000, shrunk: false, estMicro: 10_000 + 16_000 * 5 });
  });

  it('shrinks maxTokens to what the remaining budget can pay for', () => {
    const result = preflight({ ...base, desiredMaxTokens: 16_000, stepCostMicro: 120_000 });
    expect(result).toMatchObject({ action: 'run', shrunk: true, maxTokens: 4_000 });   // (30_000 − 10_000) / 5
  });

  it('falls back to the closing completion when it cannot reach 1024 tokens mid-step', () => {
    const result = preflight({ ...base, desiredMaxTokens: 16_000, stepCostMicro: 140_000, rounds: 2 });
    expect(result.action).toBe('close');
  });

  it('dies instead of starting a step it cannot afford', () => {
    const result = preflight({ ...base, desiredMaxTokens: 16_000, stepCostMicro: 140_000, rounds: 0 });
    expect(result.action).toBe('die');
  });

  it('pays for the closing completion out of the reserve even after a cap abort', () => {
    const result = preflight({ ...base, desiredMaxTokens: 1_024, stepCostMicro: MAX_STEP_COST_MICRO, closing: true });
    expect(result).toMatchObject({ action: 'run', maxTokens: 1_024, budgetMicro: STEP_SUMMARY_RESERVE_MICRO });
  });

  it('lets the closing completion shrink below the normal floor but not below 64 tokens', () => {
    expect(preflight({ ...base, desiredMaxTokens: 1_024, treasuryMicro: 12_000, closing: true }))
      .toMatchObject({ action: 'run', maxTokens: 400, shrunk: true });
    expect(preflight({ ...base, desiredMaxTokens: 1_024, treasuryMicro: 10_100, closing: true }).action).toBe('die');
  });

  it('prefers the price the provider reported', () => {
    const usage = { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costMicro: 4_242 };
    expect(usageCost(model, usage)).toBe(4_242);
    expect(usageCost(model, { ...usage, costMicro: 0 })).toBe(1_000 * 1 + 100 * 5);
  });

  it('carries the previous usage plus the new tool results into the next round', () => {
    const usage = { inputTokens: 900, outputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 60, costMicro: 0 };
    expect(carriedTokens(usage, 4_000)).toBe(900 + 100 + 40 + 60 + tokensOf(4_000));
  });
});

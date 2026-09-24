// Server-side quoting (SPEC-V2 §5.1): the same arithmetic as the browser, against whichever catalog
// the router is actually serving, plus the configured fee and the dev heartbeat override.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DAY_MS, DEFAULT_CATALOG, MIN_PROJECTED_LIFE_DAYS, QUOTE_IN_TOKENS, QUOTE_OUT_TOKENS, TIERS, bpsOf,
  estimateMicro, quoteFor, resolveTierModel, tierById, usd,
} from '@vantra/shared';
import { createPaymentsHarness, type PaymentsHarness } from './helpers.js';

let h: PaymentsHarness;
const realCatalog = DEFAULT_CATALOG.filter((m) => m.provider !== 'mock' && m.enabled);

afterEach(async () => { await h?.close(); });

describe('payments/quote with the mock catalog', () => {
  beforeEach(async () => { h = await createPaymentsHarness(); });

  it('splits the amount into the founder fee and the agent funding, exactly', () => {
    const q = h.payments.quote(usd(25));
    expect(q.feeBps).toBe(1000);
    expect(q.feeMicro).toBe(usd(2.5));
    expect(q.fundingMicro).toBe(usd(22.5));
    expect(q.feeMicro + q.fundingMicro).toBe(q.amountMicro);
    expect(q.tierId).toBe('SCOUT');
  });

  it('agrees with the shared quote for the model the router resolves', () => {
    const tier = tierById('OPERATOR')!;
    const model = resolveTierModel(tier, h.deps.llm.models())!;
    expect(model.id).toBe('mock-strong');        // SPEC-V2 §2.3 against the mock catalog
    const mine = h.payments.quote(usd(50));
    const theirs = quoteFor({ amountMicro: usd(50), feeBps: 1000, model, tier });
    expect({ ...mine, diesOn: undefined }).toMatchObject({ ...theirs, diesOn: undefined });
    expect(mine.stepCostMicro).toBe(estimateMicro(model, QUOTE_IN_TOKENS, QUOTE_OUT_TOKENS));
  });

  it('turns runwayDays into a date with the container clock', () => {
    const q = h.payments.quote(usd(25));
    expect(q.runwayDays).toBeGreaterThan(MIN_PROJECTED_LIFE_DAYS);
    expect(new Date(q.diesOn!).getTime()).toBe(h.clock.now().getTime() + q.runwayDays! * DAY_MS);
  });

  it('lets a pace trade thinking for time without going faster than the tier floor', () => {
    const tier = tierById('PRIME')!;
    const steady = h.payments.quote(usd(100), 'steady');
    const patient = h.payments.quote(usd(100), 'patient');
    const eager = h.payments.quote(usd(100), 'eager');
    expect(patient.heartbeatMin).toBeGreaterThan(steady.heartbeatMin);
    expect(eager.heartbeatMin).toBe(tier.heartbeatMin);
    expect(patient.runwayDays!).toBeGreaterThan(steady.runwayDays!);
    expect(eager.runwayDays!).toBeLessThan(steady.runwayDays!);
  });

  it('describes the four tiers with the model each one really resolves to', () => {
    const res = h.payments.tiers();
    expect(res.tiers.map((t) => t.id)).toEqual(['SPARK', 'SCOUT', 'OPERATOR', 'PRIME']);
    expect(res.tiers.map((t) => t.modelId)).toEqual(['mock-fast', 'mock-fast', 'mock-strong', 'mock-strong']);
    expect(res.tiers.every((t) => t.stepCostMicro > 0 && t.modelLabel.length > 0)).toBe(true);
    expect(res).toMatchObject({ feeBps: 1000, minMicro: usd(10), maxMicro: usd(1000), minProjectedLifeDays: MIN_PROJECTED_LIFE_DAYS });
  });
});

describe('payments/quote with the real catalog', () => {
  beforeEach(async () => { h = await createPaymentsHarness({ models: realCatalog }); });

  // The contract table in SPEC-V2 §2.5, reached through the server rather than the pure function.
  it('reproduces the published days-of-life at every tier floor', () => {
    const projected = TIERS.map((t) => h.payments.quote(t.minMicro));
    expect(projected.map((q) => [q.tierId, q.modelId, q.heartbeatMin, q.runwayDays])).toEqual([
      ['SPARK', 'gpt-5-nano', 120, 68.8],
      ['SCOUT', 'claude-haiku-4-5', 120, 79.8],
      ['OPERATOR', 'claude-sonnet-5', 120, 101.4],
      ['PRIME', 'claude-opus-5', 180, 136.4],
    ]);
  });

  it('speeds PRIME up as the money grows', () => {
    expect([100, 200, 400, 600].map((n) => {
      const q = h.payments.quote(usd(n));
      return [q.heartbeatMin, q.runwayDays];
    })).toEqual([[180, 136.4], [90, 150.0], [45, 157.9], [30, 160.7]]);
  });
});

describe('payments/quote configuration', () => {
  it('reflects HEARTBEAT_OVERRIDE_MIN so the UI never lies about what will happen', async () => {
    h = await createPaymentsHarness({ env: { HEARTBEAT_OVERRIDE_MIN: '5' } });
    const q = h.payments.quote(usd(25));
    expect(q.heartbeatMin).toBe(5);
    expect(q.stepsPerDay).toBe(288);
    expect(q.runwayDays!).toBeLessThan(10);      // honest: at 5 minutes a SCOUT burns out in under a fortnight
    // ...and the Buy page gates on this, which is what createPurchase judges: the demo can still sell.
    expect(q.gateRunwayDays!).toBeGreaterThanOrEqual(MIN_PROJECTED_LIFE_DAYS);
  });

  it('uses the configured founder fee, including zero', async () => {
    h = await createPaymentsHarness({ env: { FOUNDER_FEE_BPS: '250' } });
    const q = h.payments.quote(usd(40));
    expect(q.feeBps).toBe(250);
    expect(q.feeMicro).toBe(bpsOf(usd(40), 250));
    expect(q.fundingMicro).toBe(usd(40) - q.feeMicro);
  });

  it('falls back to the cheapest enabled model when nothing in the catalog fits the tier', async () => {
    const onlyOne = DEFAULT_CATALOG.filter((m) => m.id === 'mock-fast');
    h = await createPaymentsHarness({ models: onlyOne });
    expect(h.payments.quote(usd(100)).modelId).toBe('mock-fast');
    expect(h.payments.tiers().tiers.every((t) => t.modelId === 'mock-fast')).toBe(true);
  });
});

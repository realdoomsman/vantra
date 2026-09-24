// SPEC-V2 §2.5 + §11(A): the tier tables are contract. Every number below is asserted to one
// decimal against the real catalog and the mock catalog.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CATALOG, FOUNDER_FEE_BPS_DEFAULT, HEARTBEAT_LADDER, MAX_PURCHASE_MICRO, MIN_PURCHASE_MICRO,
  QUOTE_IN_TOKENS, QUOTE_OUT_TOKENS, RENT_PER_HOUR_MICRO, TIERS, TIER_TOOLS,
  deriveHeartbeat, estimateMicro, isTierId, nextTierAfter, paceHeartbeat, quoteFor, resolveTierModel,
  runwayDaysAt, tierById, tierForMicro,
  type AgentTier, type ModelInfo, type TierId,
} from '../src/index.js';

const REAL: ModelInfo[] = DEFAULT_CATALOG.filter((m) => m.provider !== 'mock');
const MOCK: ModelInfo[] = DEFAULT_CATALOG.filter((m) => m.provider === 'mock');
const FEE = FOUNDER_FEE_BPS_DEFAULT;

const modelFor = (tier: AgentTier, catalog: ModelInfo[]): ModelInfo => {
  const m = resolveTierModel(tier, catalog);
  if (!m) throw new Error(`no model for ${tier.id}`);
  return m;
};
const quoteAt = (amountUsd: number, catalog: ModelInfo[]) => {
  const amountMicro = amountUsd * 1_000_000;
  const tier = tierForMicro(amountMicro);
  return quoteFor({ amountMicro, feeBps: FEE, model: modelFor(tier, catalog) });
};

describe('tier table', () => {
  it('is ascending by floor and each tool set is a superset of the one below', () => {
    expect(TIERS.map((t) => t.id)).toEqual(['SPARK', 'SCOUT', 'OPERATOR', 'PRIME']);
    for (let i = 1; i < TIERS.length; i += 1) {
      expect(TIERS[i]!.minMicro).toBeGreaterThan(TIERS[i - 1]!.minMicro);
      for (const tool of TIERS[i - 1]!.enabledTools) expect(TIERS[i]!.enabledTools).toContain(tool);
    }
    expect(TIERS[0]!.minMicro).toBe(MIN_PURCHASE_MICRO);
    expect(TIER_TOOLS.PRIME).toContain('post_bounty');
    expect(TIER_TOOLS.PRIME).toContain('review_submission');
    expect(TIER_TOOLS.OPERATOR).not.toContain('post_bounty');
    expect(TIER_TOOLS.SPARK).not.toContain('web_search');
    expect(TIER_TOOLS.SCOUT).not.toContain('bash');
  });

  it('PRIME owns the fastest heartbeat in the table', () => {
    const fastest = Math.min(...TIERS.map((t) => t.heartbeatMin));
    expect(tierById('PRIME')!.heartbeatMin).toBe(fastest);
    expect(fastest).toBe(HEARTBEAT_LADDER[0]);
  });

  it('tierForMicro is monotone and clamps below the floor', () => {
    expect(tierForMicro(0).id).toBe('SPARK');
    expect(tierForMicro(MIN_PURCHASE_MICRO - 1).id).toBe('SPARK');
    let lastIndex = 0;
    for (let usd = 1; usd <= 1000; usd += 1) {
      const i = TIERS.findIndex((t) => t.id === tierForMicro(usd * 1_000_000).id);
      expect(i).toBeGreaterThanOrEqual(lastIndex);
      lastIndex = i;
    }
    expect(tierForMicro(24_999_999).id).toBe('SPARK');
    expect(tierForMicro(25_000_000).id).toBe('SCOUT');
    expect(tierForMicro(50_000_000).id).toBe('OPERATOR');
    expect(tierForMicro(100_000_000).id).toBe('PRIME');
    expect(tierForMicro(MAX_PURCHASE_MICRO).id).toBe('PRIME');
    expect(isTierId('PRIME')).toBe(true);
    expect(isTierId('GOLD')).toBe(false);
    expect(nextTierAfter(tierById('PRIME')!)).toBeNull();
  });
});

describe('step cost and rent (SPEC-V2 §2.5)', () => {
  it('prices one quote-sized step per model', () => {
    const cost = (id: string) => estimateMicro(DEFAULT_CATALOG.find((m) => m.id === id)!, QUOTE_IN_TOKENS, QUOTE_OUT_TOKENS);
    expect(cost('gpt-5-nano')).toBe(900);            // $0.0009
    expect(cost('claude-haiku-4-5')).toBe(13_500);   // $0.0135
    expect(cost('claude-sonnet-5')).toBe(27_000);    // $0.0270
    expect(cost('claude-opus-5')).toBe(67_500);      // $0.0675
    expect(RENT_PER_HOUR_MICRO * 24).toBe(120_000);  // $0.12/day
  });
});

describe('days of life at each tier floor — real catalog', () => {
  const table: Array<[TierId, string, number, number, number]> = [
    // tier, model, heartbeatMin, burn/day micro, projected life days
    ['SPARK', 'gpt-5-nano', 120, 130_800, 68.8],
    ['SCOUT', 'claude-haiku-4-5', 120, 282_000, 79.8],
    ['OPERATOR', 'claude-sonnet-5', 120, 444_000, 101.4],
    ['PRIME', 'claude-opus-5', 180, 660_000, 136.4],
  ];
  for (const [id, modelId, heartbeat, burn, life] of table) {
    it(`${id} at its floor lives ${life} days`, () => {
      const tier = tierById(id)!;
      const q = quoteFor({ amountMicro: tier.minMicro, feeBps: FEE, model: modelFor(tier, REAL) });
      expect(q.tierId).toBe(id);
      expect(q.modelId).toBe(modelId);
      expect(q.feeMicro).toBe(tier.minMicro / 10);
      expect(q.fundingMicro).toBe(tier.minMicro - q.feeMicro);
      expect(q.heartbeatMin).toBe(heartbeat);
      expect(q.burnPerDayMicro).toBe(burn);
      expect(q.runwayDays).toBeCloseTo(life, 1);
      expect(q.runwayDays!).toBeGreaterThanOrEqual(tier.targetLifeDays);
    });
  }

  it('life at the floors is strictly monotone across tiers', () => {
    const lives = TIERS.map((t) => quoteFor({ amountMicro: t.minMicro, feeBps: FEE, model: modelFor(t, REAL) }).runwayDays!);
    expect(lives).toEqual([68.8, 79.8, 101.4, 136.4]);
    for (let i = 1; i < lives.length; i += 1) expect(lives[i]!).toBeGreaterThan(lives[i - 1]!);
  });

  it('crushes the v1 baseline of 3.3 days', () => {
    const sonnet = DEFAULT_CATALOG.find((m) => m.id === 'claude-sonnet-5')!;
    const v1Burn = 20_000 * 24 + (1440 / 15) * estimateMicro(sonnet, QUOTE_IN_TOKENS, QUOTE_OUT_TOKENS);
    expect(Math.round((10_000_000 / v1Burn) * 10) / 10).toBeCloseTo(3.3, 1);
  });
});

describe('PRIME above its floor buys a faster heartbeat', () => {
  const table: Array<[number, number, number, number]> = [
    // amount usd, heartbeatMin, burn/day micro, projected life days
    [100, 180, 660_000, 136.4],
    [200, 90, 1_200_000, 150.0],
    [400, 45, 2_280_000, 157.9],
    [600, 30, 3_360_000, 160.7],
  ];
  for (const [usd, heartbeat, burn, life] of table) {
    it(`$${usd} → ${heartbeat} min, ${life} days`, () => {
      const q = quoteAt(usd, REAL);
      expect(q.tierId).toBe('PRIME');
      expect(q.heartbeatMin).toBe(heartbeat);
      expect(q.burnPerDayMicro).toBe(burn);
      expect(q.runwayDays).toBeCloseTo(life, 1);
    });
  }
  it('reaches the tier floor heartbeat and never goes past it', () => {
    expect(quoteAt(1000, REAL).heartbeatMin).toBe(tierById('PRIME')!.heartbeatMin);
  });
});

describe('mock catalog (LLM_PROVIDER=mock, the local runnable path)', () => {
  const table: Array<[TierId, string, number, number]> = [
    ['SPARK', 'mock-fast', 720, 61.2],
    ['SCOUT', 'mock-fast', 120, 79.8],
    ['OPERATOR', 'mock-strong', 360, 115.4],
    ['PRIME', 'mock-strong', 180, 136.4],
  ];
  for (const [id, modelId, heartbeat, life] of table) {
    it(`${id} resolves to ${modelId} and lives ${life} days`, () => {
      const tier = tierById(id)!;
      expect(resolveTierModel(tier, MOCK)!.id).toBe(modelId);
      const q = quoteFor({ amountMicro: tier.minMicro, feeBps: FEE, model: modelFor(tier, MOCK) });
      expect(q.heartbeatMin).toBe(heartbeat);
      expect(q.runwayDays).toBeCloseTo(life, 1);
    });
  }
});

describe('resolveTierModel', () => {
  it('prefers the exact model id when the catalog has it', () => {
    for (const t of TIERS) expect(resolveTierModel(t, REAL)!.id).toBe(t.modelId);
  });
  it('falls back to the cheapest model of the same class', () => {
    const noSonnet = REAL.filter((m) => m.id !== 'claude-sonnet-5');
    expect(resolveTierModel(tierById('OPERATOR')!, noSonnet)!.tier).toBe('strong');
    expect(resolveTierModel(tierById('OPERATOR')!, noSonnet)!.id).toBe('gpt-5.6-terra');
  });
  it('walks DOWN the class ladder before walking up', () => {
    const cheapOnly = REAL.filter((m) => m.tier === 'cheap');
    expect(resolveTierModel(tierById('PRIME')!, cheapOnly)!.id).toBe('gpt-5-nano');
    const frontierOnly = REAL.filter((m) => m.tier === 'frontier');
    expect(resolveTierModel(tierById('SPARK')!, frontierOnly)!.id).toBe('gpt-5.6-sol');
  });
  it('returns null when nothing is enabled', () => {
    expect(resolveTierModel(tierById('SPARK')!, [])).toBeNull();
    expect(resolveTierModel(tierById('SPARK')!, REAL.map((m) => ({ ...m, enabled: false })))).toBeNull();
  });
});

describe('quote arithmetic', () => {
  it('fee + funding === amount for 1000 random amounts', () => {
    for (let i = 0; i < 1000; i += 1) {
      const amountMicro = MIN_PURCHASE_MICRO + Math.floor(Math.random() * (MAX_PURCHASE_MICRO - MIN_PURCHASE_MICRO));
      const tier = tierForMicro(amountMicro);
      const q = quoteFor({ amountMicro, feeBps: FEE, model: modelFor(tier, REAL) });
      expect(Number.isInteger(q.feeMicro)).toBe(true);
      expect(Number.isInteger(q.fundingMicro)).toBe(true);
      expect(q.feeMicro + q.fundingMicro).toBe(amountMicro);
      expect(q.tierId).toBe(tier.id);
    }
  });

  it('nextTier says exactly what the upgrade costs', () => {
    const q = quoteFor({ amountMicro: 22_000_000, feeBps: FEE, model: modelFor(tierById('SPARK')!, REAL) });
    expect(q.nextTier).toEqual({ id: 'SCOUT', minMicro: 25_000_000, addMicro: 3_000_000 });
    expect(quoteAt(600, REAL).nextTier).toBeNull();
  });

  it('a zero fee leaves the whole amount with the agent', () => {
    const q = quoteFor({ amountMicro: 25_000_000, feeBps: 0, model: modelFor(tierById('SCOUT')!, REAL) });
    expect(q.feeMicro).toBe(0);
    expect(q.fundingMicro).toBe(25_000_000);
  });

  it('a heartbeat override wins over the derivation, so the UI never lies', () => {
    const tier = tierById('SCOUT')!;
    const q = quoteFor({ amountMicro: tier.minMicro, feeBps: FEE, model: modelFor(tier, REAL), heartbeatOverrideMin: 5 });
    expect(q.heartbeatMin).toBe(5);
    expect(q.stepsPerDay).toBe(288);
    expect(q.runwayDays!).toBeLessThan(10);
  });
});

describe('runway is strictly increasing in the amount within a tier', () => {
  // At a FIXED heartbeat — which is what `pace: 'eager'` pins — more money is strictly more days.
  it('holds across every tier band at eager pace', () => {
    for (const tier of TIERS) {
      const next = nextTierAfter(tier);
      const topUsd = next ? next.minUsd - 1 : 200;
      const model = modelFor(tier, REAL);
      let prev = -1;
      for (let usd = tier.minUsd; usd <= topUsd; usd += 1) {
        const q = quoteFor({ amountMicro: usd * 1_000_000, feeBps: FEE, model, pace: 'eager' });
        expect(q.heartbeatMin).toBe(tier.heartbeatMin);
        expect(q.runwayDays!).toBeGreaterThan(prev);
        prev = q.runwayDays!;
      }
    }
  });

  // At the derived ('steady') heartbeat the agent spends the extra money on THINKING FASTER, so the
  // projection climbs inside a rung and steps back to the tier's guaranteed minimum when a faster
  // rung unlocks. Both properties are asserted; the guarantee is never broken.
  it('climbs within each heartbeat rung and never drops below the tier target', () => {
    for (const tier of TIERS) {
      const next = nextTierAfter(tier);
      const topUsd = next ? next.minUsd - 1 : 1000;
      const model = modelFor(tier, REAL);
      let prevLife = -1;
      let prevBeat = Number.POSITIVE_INFINITY;
      for (let usd = tier.minUsd; usd <= topUsd; usd += 1) {
        const q = quoteFor({ amountMicro: usd * 1_000_000, feeBps: FEE, model });
        expect(q.runwayDays!).toBeGreaterThanOrEqual(tier.targetLifeDays);
        expect(q.heartbeatMin).toBeLessThanOrEqual(prevBeat);       // money only ever speeds it up
        expect(q.heartbeatMin).toBeGreaterThanOrEqual(tier.heartbeatMin);
        if (q.heartbeatMin === prevBeat) expect(q.runwayDays!).toBeGreaterThan(prevLife);
        prevBeat = q.heartbeatMin;
        prevLife = q.runwayDays!;
      }
    }
  });

  it('is NOT monotone across a tier boundary — the honesty rule (§2.5)', () => {
    const spark = quoteAt(24, REAL);
    const scout = quoteAt(25, REAL);
    expect(spark.tierId).toBe('SPARK');
    expect(scout.tierId).toBe('SCOUT');
    expect(spark.runwayDays!).toBeGreaterThan(scout.runwayDays!);
    expect(spark.runwayDays).toBeCloseTo(165.1, 1);
    expect(scout.runwayDays).toBeCloseTo(79.8, 1);
  });
});

describe('pace', () => {
  it('eager pins the tier floor, patient is two rungs slower, steady is the derivation', () => {
    const tier = tierById('PRIME')!;
    const model = modelFor(tier, REAL);
    const funding = quoteFor({ amountMicro: tier.minMicro, feeBps: FEE, model }).fundingMicro;
    const steady = deriveHeartbeat(tier, funding, model);
    expect(paceHeartbeat(tier, funding, model, 'steady')).toBe(steady);
    expect(paceHeartbeat(tier, funding, model, 'eager')).toBe(tier.heartbeatMin);
    const i = HEARTBEAT_LADDER.indexOf(steady);
    expect(paceHeartbeat(tier, funding, model, 'patient')).toBe(HEARTBEAT_LADDER[Math.min(i + 2, HEARTBEAT_LADDER.length - 1)]);
  });

  it('never runs faster than the tier floor and never slower than the last rung', () => {
    for (const tier of TIERS) {
      const model = modelFor(tier, REAL);
      for (const pace of ['patient', 'steady', 'eager'] as const) {
        const h = paceHeartbeat(tier, tier.minMicro, model, pace);
        expect(h).toBeGreaterThanOrEqual(tier.heartbeatMin);
        expect(h).toBeLessThanOrEqual(HEARTBEAT_LADDER[HEARTBEAT_LADDER.length - 1]!);
      }
    }
  });

  it('patient buys days, eager buys thinking', () => {
    const tier = tierById('PRIME')!;
    const model = modelFor(tier, REAL);
    const base = { amountMicro: tier.minMicro, feeBps: FEE, model };
    const patient = quoteFor({ ...base, pace: 'patient' });
    const steady = quoteFor({ ...base, pace: 'steady' });
    const eager = quoteFor({ ...base, pace: 'eager' });
    expect(patient.runwayDays!).toBeGreaterThan(steady.runwayDays!);
    expect(steady.runwayDays!).toBeGreaterThan(eager.runwayDays!);
    expect(eager.stepsPerDay).toBeGreaterThan(steady.stepsPerDay);
  });
});

describe('deriveHeartbeat', () => {
  it('bottoms out at the slowest rung when no rung can reach the target', () => {
    const tier = tierById('PRIME')!;
    const model = modelFor(tier, REAL);
    expect(deriveHeartbeat(tier, 1_000, model)).toBe(1440);
  });
  it('runwayDaysAt agrees with the quote', () => {
    const tier = tierById('SCOUT')!;
    const model = modelFor(tier, REAL);
    const q = quoteFor({ amountMicro: tier.minMicro, feeBps: FEE, model });
    expect(runwayDaysAt(q.heartbeatMin, q.fundingMicro, model)).toBe(q.runwayDays);
  });
});

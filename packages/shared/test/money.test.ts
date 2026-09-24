import { describe, expect, it } from 'vitest';
import { bpsOf, ceilMicro, estimateMicro, fmtUsd, microToUsd, priceUsage, usd } from '../src/money.js';
import { DEFAULT_CATALOG, findModel } from '../src/catalog.js';

const sonnet = findModel('claude-sonnet-5')!;
const luna = findModel('gpt-5.6-luna')!;

describe('usd / microToUsd', () => {
  it('round-trips dollars to micro', () => {
    expect(usd(10)).toBe(10_000_000);
    expect(usd(0.0043)).toBe(4_300);
    expect(microToUsd(1_234_560)).toBeCloseTo(1.23456);
  });
});

describe('ceilMicro', () => {
  it('ignores binary float noise', () => {
    expect(ceilMicro(1000 * 0.2)).toBe(200);   // 200.00000000000003 in IEEE-754
    expect(ceilMicro(3 * 0.1)).toBe(1);
    expect(ceilMicro(0)).toBe(0);
    expect(ceilMicro(200.4)).toBe(201);
  });
});

describe('bpsOf', () => {
  it('computes basis points', () => {
    expect(bpsOf(10_000_000, 250)).toBe(250_000);  // 2.5% of $10
    expect(bpsOf(1_000_000, 500)).toBe(50_000);
    expect(bpsOf(0, 500)).toBe(0);
  });
});

describe('fmtUsd', () => {
  it('formats dollars with grouping and sign', () => {
    expect(fmtUsd(1_234_560_000)).toBe('$1,234.56');
    expect(fmtUsd(-1_230_000)).toBe('-$1.23');
    expect(fmtUsd(4_300)).toBe('$0.0043');
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(5_000_000, { sign: true })).toBe('+$5.00');
    expect(fmtUsd(1_234_000_000, { compact: true })).toBe('$1.2k');
    expect(fmtUsd(3_000_000_000_000, { compact: true })).toBe('$3M');
    expect(fmtUsd(123_456, { decimals: 3 })).toBe('$0.123');
  });
});

describe('priceUsage', () => {
  it('prices tokens at USD per 1M (AMENDMENTS A5)', () => {
    const micro = priceUsage(sonnet, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(micro).toBe(1000 * 2 + 500 * 10); // 7_000 micro = $0.007
  });
  it('applies cache read/write defaults (0.1× / 1.25× input)', () => {
    const micro = priceUsage(sonnet, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 10_000, cacheWriteTokens: 1_000 });
    expect(micro).toBe(10_000 * 0.2 + 1_000 * 2.5);
  });
  it('honours explicit cache prices', () => {
    const m = { ...sonnet, cacheReadPerM: 1, cacheWritePerM: 4 };
    expect(priceUsage(m, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 100 })).toBe(500);
  });
  it('never produces float-noise overcharges', () => {
    expect(priceUsage(luna, { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(200);
  });
});

describe('estimateMicro', () => {
  it('estimates uncached input + output', () => {
    expect(estimateMicro(sonnet, 3000, 600)).toBe(3000 * 2 + 600 * 10);
    expect(estimateMicro(luna, 6000, 1000)).toBe(1200 + 1200);
  });
  it('orders the catalog by cost for cheapest()', () => {
    const cheapest = [...DEFAULT_CATALOG].sort((a, b) => estimateMicro(a, 3000, 600) - estimateMicro(b, 3000, 600))[0]!;
    expect(cheapest.id).toBe('gpt-5-nano');
  });
});

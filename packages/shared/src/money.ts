// Money math. Everything is integer micro-dollars; token prices are USD per 1M tokens,
// so `tokens × pricePerM` is already micro-dollars (AMENDMENTS A5).
import type { Micro, ModelInfo } from './types.js';

export const MICRO = 1_000_000;

export function usd(n: number): Micro {
  return Math.round(n * MICRO);
}

export function microToUsd(m: Micro): number {
  return m / MICRO;
}

// Ceil that ignores binary float noise: 1000 × 0.2 = 200.00000000000003 → 200, not 201.
export function ceilMicro(x: number): Micro {
  return Math.ceil(Math.round(x * MICRO) / MICRO);
}

export function bpsOf(m: Micro, bps: number): Micro {
  return Math.round((m * bps) / 10_000);
}

export interface FmtUsdOpts {
  sign?: boolean;      // prefix '+' for positive values
  compact?: boolean;   // $1.2k / $3.4M
  decimals?: number;   // force a fixed number of decimals
}

// $1,234.56 · sub-cent amounts get 4 decimals so step costs stay readable · negative → -$1.23
export function fmtUsd(m: Micro, opts: FmtUsdOpts = {}): string {
  const neg = m < 0;
  const abs = Math.abs(m) / MICRO;
  let body: string;
  if (opts.compact && abs >= 1_000) {
    const units: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
    const [div, suffix] = units.find(([d]) => abs >= d) ?? [1, ''];
    body = `${trimZeros((abs / div).toFixed(1))}${suffix}`;
  } else {
    const decimals = opts.decimals ?? (abs > 0 && abs < 0.01 ? 4 : 2);
    body = group(abs.toFixed(decimals));
  }
  const prefix = neg ? '-' : opts.sign && m > 0 ? '+' : '';
  return `${prefix}$${body}`;
}

function group(fixed: string): string {
  const [int = '0', frac] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}

function trimZeros(fixed: string): string {
  return fixed.replace(/\.0+$/, '');
}

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // Subset of `cacheWriteTokens` written at the 1-hour TTL. Anthropic bills a 1h cache write at 2×
  // base input, a 5m write at 1.25×, and reports the split in `usage.cache_creation`. Omitted (or 0)
  // means the whole write was at the 5-minute rate — which is what every non-Anthropic provider does.
  cacheWrite1hTokens?: number;
}

export type ModelPricing = Pick<ModelInfo, 'inputPerM' | 'outputPerM' | 'cacheReadPerM' | 'cacheWritePerM' | 'cacheWrite1hPerM'>;

export const cacheReadPerM = (m: ModelPricing): number => m.cacheReadPerM ?? m.inputPerM * 0.1;
export const cacheWritePerM = (m: ModelPricing): number => m.cacheWritePerM ?? m.inputPerM * 1.25;
export const cacheWrite1hPerM = (m: ModelPricing): number => m.cacheWrite1hPerM ?? m.inputPerM * 2;

// Cost of one completion in micro-dollars (AMENDMENTS A5).
export function priceUsage(model: ModelPricing, usage: UsageTokens): Micro {
  const write1h = Math.min(Math.max(usage.cacheWrite1hTokens ?? 0, 0), usage.cacheWriteTokens);
  const write5m = usage.cacheWriteTokens - write1h;
  return ceilMicro(
    usage.inputTokens * model.inputPerM +
      write5m * cacheWritePerM(model) +
      write1h * cacheWrite1hPerM(model) +
      usage.cacheReadTokens * cacheReadPerM(model) +
      usage.outputTokens * model.outputPerM,
  );
}

// Pre-flight estimate treating all input as uncached.
export function estimateMicro(model: ModelPricing, inTok: number, outTok: number): Micro {
  return ceilMicro(inTok * model.inputPerM + outTok * model.outputPerM);
}

// Formatting for a launched coin. Token amounts arrive as 18-dp base-unit decimal strings, which
// overflow every JS number type — so every step here is bigint, and nothing is ever `Number()`ed.
import type { LaunchPublic } from '@vantra/shared';

const DECIMALS = 18n;
const ONE = 10n ** DECIMALS;

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Whole tokens with thousands separators and `frac` truncated decimals: '12,345,678.90'.
 * A non-zero amount that truncates to zero reads '<0.01' rather than a misleading '0.00'.
 */
export function fmtTokenUnits(units: string, frac = 2): string {
  const v = BigInt(units);
  const whole = v / ONE;
  const scale = 10n ** BigInt(frac);
  const part = ((v % ONE) * scale) / ONE;
  if (whole === 0n && part === 0n && v > 0n) return frac === 0 ? '<1' : `<0.${'0'.repeat(frac - 1)}1`;
  const head = group(whole.toString());
  return frac === 0 ? head : `${head}.${part.toString().padStart(frac, '0')}`;
}

const COMPACT: readonly [bigint, string][] = [
  [1_000_000_000n, 'B'],
  [1_000_000n, 'M'],
  [1_000n, 'K'],
];

/** Headline token count: '12.3M', '847.1K', '912'. One truncated decimal, bigint all the way. */
export function fmtTokenCompact(units: string): string {
  const v = BigInt(units);
  if (v === 0n) return '0';
  const whole = v / ONE;
  for (const [div, suffix] of COMPACT) {
    if (whole < div) continue;
    const tenths = (v * 10n) / (ONE * div);
    const text = `${group((tenths / 10n).toString())}.${(tenths % 10n).toString()}`;
    return `${text.replace(/\.0$/, '')}${suffix}`;
  }
  return fmtTokenUnits(units, whole === 0n ? 2 : 0);
}

/** Share of the 1B supply burned. Small burns keep three decimals so the first one is visible. */
export function fmtBurnPct(pct: number): string {
  if (pct <= 0) return '0%';
  if (pct < 0.001) return '<0.001%';
  return `${pct.toFixed(pct < 1 ? 3 : 2)}%`;
}

/** Creator tax: 500 bps → '5%', 250 → '2.5%'. */
export function fmtTaxBps(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : bps % 10 === 0 ? 1 : 2)}%`;
}

/** 0..1 progress of pending fees toward the activation threshold. */
export function activationProgress(l: Pick<LaunchPublic, 'feesPendingMicro' | 'activationMicro'>): number {
  if (l.activationMicro <= 0) return 1;
  return Math.min(1, Math.max(0, l.feesPendingMicro / l.activationMicro));
}

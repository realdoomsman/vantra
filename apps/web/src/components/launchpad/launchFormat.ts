// Presentation rules for a launched coin, shared by the directory card and the launch form.
import type { AgentStatus, LaunchPublic, Micro } from '@vantra/shared';
import { MICRO } from '@vantra/shared';
import { fmtCompact } from '../../lib/format';

/** 500 → '5%', 250 → '2.5%', 125 → '1.25%'. */
export function fmtTax(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** Days left: '—' when unknown, '18h' under a day, '42d', '3.2y'. */
export function fmtRunway(days: number | null): string {
  if (days === null || !Number.isFinite(days)) return '—';
  if (days < 1) return `${Math.max(0, Math.floor(days * 24))}h`;
  if (days < 10) return `${days.toFixed(1)}d`;
  if (days < 365) return `${Math.floor(days)}d`;
  return `${(days / 365).toFixed(1)}y`;
}

/** Share of the 1B supply burned: '0%', '<0.01%', '0.42%', '12.3%'. */
export function fmtBurnedPct(pct: number): string {
  if (pct <= 0) return '0%';
  if (pct < 0.01) return '<0.01%';
  if (pct < 10) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(1)}%`;
}

/** Compact dollars for large figures: '$840', '$12.9K', '$4.2M'. Cents survive under $100. */
export function fmtUsdCompact(m: Micro): string {
  const n = m / MICRO;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${fmtCompact(Math.round(n))}`;
}

/** Fees the coin has earned for its AI: everything claimed plus what sits claimable in escrow. */
export const feesEarnedMicro = (l: Pick<LaunchPublic, 'feesClaimedMicro' | 'feesPendingMicro'>): Micro =>
  l.feesClaimedMicro + l.feesPendingMicro;

/** Pending escrow as a share of the activation threshold, 0..1. */
export function activationProgress(l: Pick<LaunchPublic, 'feesPendingMicro' | 'activationMicro'>): number {
  if (l.activationMicro <= 0) return 1;
  return Math.min(1, Math.max(0, l.feesPendingMicro / l.activationMicro));
}

export type StatusTone = 'live' | 'idle' | 'dead';

/** What the coin's AI is doing, in one word, and the tone of the dot beside it. */
export function aiStatus(status: AgentStatus): { label: string; tone: StatusTone } {
  switch (status) {
    case 'alive':
      return { label: 'ALIVE', tone: 'live' };
    case 'dormant':
      return { label: 'DORMANT', tone: 'idle' };
    case 'spawning':
      return { label: 'WAKING', tone: 'idle' };
    case 'sleeping':
      return { label: 'SLEEPING', tone: 'idle' };
    case 'paused':
      return { label: 'PAUSED', tone: 'idle' };
    case 'dead':
      return { label: 'DEAD', tone: 'dead' };
  }
}

/**
 * Trading volume a coin needs before its fees reach `unlockMicro`, at `taxBps`. It is a floor: the
 * creator also earns a share of Pons's base fee on top of the tax, so real fees arrive sooner.
 * Null at 0% tax, where the tax alone never gets there.
 */
export function volumeForUnlock(unlockMicro: Micro, taxBps: number): number | null {
  if (taxBps <= 0) return null;
  return unlockMicro / MICRO / (taxBps / 10_000);
}

/** '$1.0K' style volume label; '—' when the tax alone never reaches it. */
export function fmtVolume(usd: number | null): string {
  if (usd === null) return '—';
  return `$${fmtCompact(Math.round(usd))}`;
}

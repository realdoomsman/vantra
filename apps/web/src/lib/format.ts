// Presentation helpers. Money formatting lives in @vantra/shared (fmtUsd);
// everything here is dates, ages, addresses and links.
import type { ChainMode } from '@vantra/shared';

const pad2 = (n: number): string => String(n).padStart(2, '0');

const toDate = (ts: string | number | Date): Date => (ts instanceof Date ? ts : new Date(ts));

/** A bare `yyyy-mm-dd` day key, as `/api/stats/series` emits. */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * yyyy-mm-dd (local time), EXCEPT for a bare day key, which is a calendar date and not an instant:
 * `new Date('2026-09-16')` parses as UTC midnight, so formatting it locally renders "2026-09-15" for
 * every viewer west of UTC and shifts every chart axis, tooltip and table row back a day.
 */
export function fmtDate(ts: string | number | Date): string {
  if (typeof ts === 'string' && DAY_KEY_RE.test(ts)) return ts;
  const d = toDate(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** HH:MM (local time). */
export function fmtTime(ts: string | number | Date): string {
  const d = toDate(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** yyyy-mm-dd HH:MM. */
export function fmtDateTime(ts: string | number | Date): string {
  return `${fmtDate(ts)} ${fmtTime(ts)}`;
}

/** Whole-day age label: 'D+12'. */
export function fmtAgeDays(days: number): string {
  return `D+${Math.max(0, Math.floor(days))}`;
}

/** Day index of `ts` relative to birth, per D32: D+{floor((ts−bornAt)/86400000)}. */
export function dayIndex(ts: string | number | Date, bornAt: string | number | Date): number {
  return Math.max(0, Math.floor((toDate(ts).getTime() - toDate(bornAt).getTime()) / 86_400_000));
}

/** 'D+3 14:02' — decision log timestamp (D32). */
export function fmtDecisionDay(ts: string, bornAt: string): string {
  return `D+${dayIndex(ts, bornAt)} ${fmtTime(ts)}`;
}

/** Relative age of a timestamp: '12s ago', '3m ago', '2h ago', '5d ago'. */
export function fmtAgo(ts: string | number | Date, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - toDate(ts).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** mm:ss until a timestamp; clamps at 00:00. */
export function fmtCountdown(to: string | number | Date, now: number = Date.now()): string {
  const left = Math.max(0, Math.round((toDate(to).getTime() - now) / 1000));
  return `${pad2(Math.floor(left / 60))}:${pad2(left % 60)}`;
}

/**
 * Coarse time remaining: '2d 4h', '3h 07m', '04m 12s', 'EXPIRED'. `fmtCountdown` is mm:ss, which is
 * right for a heartbeat and useless for a 72-hour deposit window that would read '4319:58'.
 */
export function fmtUntil(to: string | number | Date, now: number = Date.now()): string {
  const s = Math.round((toDate(to).getTime() - now) / 1000);
  if (s <= 0) return 'EXPIRED';
  if (s < 3600) return `${pad2(Math.floor(s / 60))}m ${pad2(s % 60)}s`;
  const h = Math.floor(s / 3600);
  if (h < 48) return `${h}h ${pad2(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** 'Ab3d…9xYz' for addresses and tx hashes. */
export function shortKey(key: string, head = 4, tail = 4): string {
  if (key.length <= head + tail + 1) return key;
  return `${key.slice(0, head)}…${key.slice(-tail)}`;
}

/** First 8 characters of a transaction hash (ledger tx column, D33). */
export function shortSig(sig: string): string {
  return sig.slice(0, 8);
}

/**
 * Whatever the API published about the chain. `explorerUrl` is the Blockscout root and is '' in
 * memory mode, where simulated hashes point at nothing and no link may be rendered (D33).
 */
export interface ChainRef {
  mode: ChainMode;
  explorerUrl: string;
}

const explorerLink = (chain: ChainRef, path: 'address' | 'tx', id: string): string | null =>
  (chain.mode === 'memory' || chain.explorerUrl === '' ? null : `${chain.explorerUrl.replace(/\/+$/, '')}/${path}/${id}`);

/** Blockscout address link; null in memory mode (D33). */
export function explorerAddressUrl(pubkey: string, chain: ChainRef): string | null {
  return explorerLink(chain, 'address', pubkey);
}

/** Blockscout transaction link; null in memory mode. */
export function explorerTxUrl(sig: string, chain: ChainRef): string | null {
  return explorerLink(chain, 'tx', sig);
}

/** Compact integer: 1,284 / 12.9K / 4.2M. */
export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString('en-US');
}

/** Whole tokens with thousands separators. */
export function fmtTokens(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** 0.42 → '42%'. */
export function fmtPct(fraction: number, digits = 0): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** First sentence of a paragraph (graveyard cause, D37). */
export function firstSentence(text: string): string {
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(text.trim());
  return (m ? m[0] : text).trim();
}

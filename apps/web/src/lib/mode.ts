import type { ChainPublic, GlobalStats } from '@vantra/shared';
import { RHC_MAINNET_RPC } from './chains';

export type ModeLabel = 'DEMO' | 'SIM' | 'TESTNET' | 'MAINNET';

/** One thing about this run that is not real: a short name for the chip and the full sentence. */
export interface ModeNotice {
  name: string;
  detail: string;
}

export interface ModeInfo {
  label: ModeLabel;
  /** Every simulated part of this run (D29); empty ONLY when money, brains and the colony are all real. */
  notice: ModeNotice[];
  /** '.ticker-label' text (D29). The mode label rides in the notice when there is one. */
  tickerLabel: string;
}

type ModeStats = Pick<GlobalStats, 'chain' | 'llm'> & Partial<Pick<GlobalStats, 'demo'>>;

/**
 * The mode line, per AMENDMENTS D29 and the v2 no-fallback rule.
 *
 * The notice is COMPOSED from three independent facts rather than picked from a table, because the
 * three can disagree: real testnet money behind mock brains, real brains over a simulated chain, a
 * seeded demo colony on either. An earlier version keyed only off `chain.mode`, so a testnet run with
 * LLM_PROVIDER=mock showed "TESTNET · TEST USDC" and said nothing at all about the agents being
 * scripted — exactly the "I think I am running for real" state this notice exists to prevent.
 *
 * Every item states something that has been checked. Nothing is implied by omission except the
 * one case where all three are real, which is the only time the notice is empty.
 */
export function modeInfo(stats: ModeStats | null): ModeInfo {
  if (!stats) return { label: 'SIM', notice: [], tickerLabel: 'LIVE' };

  const demo = stats.demo === true;
  const memory = stats.chain.mode === 'memory';
  const mainnet = !memory && stats.chain.cluster === 'mainnet';
  const mock = stats.llm.provider === 'mock';

  const notice: ModeNotice[] = [];
  if (demo) notice.push({ name: 'SEEDED COLONY', detail: 'Demo colony — seeded, not real customers.' });
  if (memory) notice.push({ name: 'SIM CHAIN', detail: 'Simulated chain — no real money moves.' });
  else if (!mainnet) {
    const cluster = stats.chain.cluster.toUpperCase();
    notice.push({ name: `${cluster} USDC`, detail: `${cluster} — test USDC, not real money.` });
  }
  if (mock) notice.push({ name: 'MOCK AI', detail: 'Mock brains — agents are scripted, not thinking.' });

  const label: ModeLabel = demo ? 'DEMO' : memory ? 'SIM' : mainnet ? 'MAINNET' : 'TESTNET';
  return { label, notice, tickerLabel: notice.length > 0 ? 'LIVE' : `LIVE · ${label}` };
}

/** Short chain badge text for the topbar: testnet / mainnet / memory. */
export function chainBadge(stats: Pick<GlobalStats, 'chain'> | null): string {
  if (!stats) return '…';
  return stats.chain.mode === 'memory' ? 'memory' : stats.chain.cluster;
}

/** RPC endpoint the browser reads Robinhood Chain through (mainnet's public node until stats arrive). */
export function rpcEndpoint(chain: Pick<ChainPublic, 'mode' | 'cluster'> | null): string {
  const override = import.meta.env.VITE_RHC_RPC_URL;
  if (override) return override;
  // On a real chain, talk to the API's own /rpc proxy: same origin in prod, vite-proxied in dev. The
  // testnet endpoint carries an Alchemy key that must never reach a browser bundle, and the public
  // mainnet node is keyless but rate-limited with no SLA, so the server's endpoint is the better
  // read path for both. Mainnet's public node is the fallback for the seconds before /api/stats
  // answers and for a memory-mode deployment, where nothing on chain is ever read anyway.
  if (chain?.mode === 'robinhood' && typeof window !== 'undefined') return `${window.location.origin}/rpc`;
  return RHC_MAINNET_RPC;
}

// Forking a published strategy (SPEC §8.4.7) and the 5% royalty a child pays its parent (§8.7).
import { eq } from 'drizzle-orm';
import { FORK_ROYALTY_BPS, MEMORY_NOTE_MAX_CHARS, bpsOf, fmtUsd, type Micro } from '@vantra/shared';
import type { CoreDeps } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import { agents, forks, type AgentRow, type ForkRow } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { post } from './ledger.js';

export const FORK_MEMORY_MAX_NOTES = 10;

type Deps = Pick<CoreDeps, 'db' | 'clock' | 'bus' | 'log'>;

// The parent must still be sharing a strategy at spawn time.
export async function loadForkParent(db: DbLike, parentId: string): Promise<AgentRow> {
  const [parent] = await db.select().from(agents).where(eq(agents.id, parentId));
  if (!parent) throw notFound('Parent agent');
  if (!parent.shareStrategy || !parent.strategy?.trim()) {
    throw conflict('NOT_ELIGIBLE', `${parent.name} is not sharing a strategy`);
  }
  return parent;
}

// Seed memory: a header note plus the strategy split into ≤300-char notes (max 10).
export function forkMemory(parentName: string, strategy: string): string[] {
  return [`Forked strategy from ${parentName}:`, ...chunk(strategy.trim(), MEMORY_NOTE_MAX_CHARS).slice(0, FORK_MEMORY_MAX_NOTES)];
}

// Greedy split on paragraph, then sentence/space boundaries, so notes stay readable.
function chunk(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= max) {
      out.push(rest);
      break;
    }
    const window = rest.slice(0, max + 1);
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf(' '));
    const at = cut > max * 0.5 ? cut : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  return out.filter((s) => s.length > 0);
}

export async function recordFork(db: DbLike, parentId: string, childId: string): Promise<void> {
  await db.insert(forks).values({ parentAgentId: parentId, childAgentId: childId, royaltyBps: FORK_ROYALTY_BPS });
}

async function forkOfChild(db: DbLike, childId: string): Promise<ForkRow | null> {
  const [row] = await db.select().from(forks).where(eq(forks.childAgentId, childId));
  return row ?? null;
}

// 5% of a child's external revenue is booked immediately on both sides; the USDC moves in settlement.
export async function accrueRoyalty(deps: Deps, db: DbLike, child: AgentRow, externalMicro: Micro): Promise<Micro> {
  if (!child.forkedFrom || externalMicro <= 0) return 0;
  const fork = await forkOfChild(db, child.id);
  if (!fork) return 0;
  const amount = bpsOf(externalMicro, fork.royaltyBps);
  if (amount <= 0) return 0;
  const [parent] = await db.select().from(agents).where(eq(agents.id, fork.parentAgentId));
  if (!parent) return 0;

  await post(deps, db, {
    agentId: child.id, kind: 'royalty_out', amountMicro: -amount,
    memo: `fork royalty to ${parent.name} (${fork.royaltyBps / 100}%)`, counterparty: parent.walletPubkey,
    meta: { parentAgentId: parent.id, onMicro: externalMicro },
  });
  await post(deps, db, {
    agentId: parent.id, kind: 'royalty_in', amountMicro: amount,
    memo: `fork royalty from ${child.name} (${fmtUsd(amount)})`, counterparty: child.walletPubkey,
    meta: { childAgentId: child.id, onMicro: externalMicro },
  });
  return amount;
}

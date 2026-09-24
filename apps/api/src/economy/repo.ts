// Small row accessors shared across economy/ and runtime/.
import { and, desc, eq, ne } from 'drizzle-orm';
import { isWalletlessOwnerId, type OwnerKind } from '@vantra/shared';
import type { DbLike } from '../db/client.js';
import { agents, users, type AgentRow, type UserRow } from '../db/schema.js';
import { forbidden, notFound } from '../lib/errors.js';

export async function loadAgent(db: DbLike, id: string): Promise<AgentRow | null> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id));
  return row ?? null;
}

export async function requireAgent(db: DbLike, id: string): Promise<AgentRow> {
  const row = await loadAgent(db, id);
  if (!row) throw notFound('Agent');
  return row;
}

// `ownerId` is an owner id: a base58 wallet pubkey, or `claim_pu_…` for the no-wallet path. The
// column keeps its name; only its meaning widened (SPEC-V2 §6.2).
export async function requireOwned(db: DbLike, id: string, ownerId: string): Promise<AgentRow> {
  const row = await requireAgent(db, id);
  if (row.ownerWallet !== ownerId) throw forbidden('Only the owner can do that');
  return row;
}

export async function isOwnerOf(db: DbLike, agentId: string, ownerId: string): Promise<boolean> {
  const [row] = await db.select({ owner: agents.ownerWallet }).from(agents).where(eq(agents.id, agentId)).limit(1);
  return row !== undefined && row.owner === ownerId;
}

// Locks the row for the rest of the enclosing transaction.
export async function lockAgent(db: DbLike, id: string): Promise<AgentRow> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id)).for('update');
  if (!row) throw notFound('Agent');
  return row;
}

// v2 has no per-owner limit — you own as many agents as you paid for — so this returns all of them.
export async function liveAgentsOfOwner(db: DbLike, ownerId: string, excludeId?: string): Promise<AgentRow[]> {
  const conds = [eq(agents.ownerWallet, ownerId), ne(agents.status, 'dead')];
  if (excludeId) conds.push(ne(agents.id, excludeId));
  return db.select().from(agents).where(and(...conds)).orderBy(desc(agents.bornAt));
}

export async function agentsOfOwner(db: DbLike, ownerId: string): Promise<AgentRow[]> {
  return db.select().from(agents).where(eq(agents.ownerWallet, ownerId)).orderBy(desc(agents.bornAt));
}

export async function ensureUser(db: DbLike, ownerId: string, now: Date, kind: OwnerKind = 'wallet'): Promise<void> {
  await db.insert(users).values({ wallet: ownerId, kind, createdAt: now, lastLoginAt: now })
    .onConflictDoNothing({ target: users.wallet });
}

export async function loadUser(db: DbLike, ownerId: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.wallet, ownerId)).limit(1);
  return row ?? null;
}

// Where an owner's withdrawals go: their payout wallet when set, else the pubkey they signed in with.
// A claim identity has no pubkey of its own, so it must set one before it can be paid (§6.2).
export async function payoutWalletOf(db: DbLike, ownerId: string): Promise<string | null> {
  const user = await loadUser(db, ownerId);
  if (user?.payoutWallet) return user.payoutWallet;
  return isWalletlessOwnerId(ownerId) ? null : ownerId;
}

export const isLive = (a: Pick<AgentRow, 'status'>): boolean => a.status === 'alive' || a.status === 'sleeping' || a.status === 'paused';

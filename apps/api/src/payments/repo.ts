// Typed row access for `purchases` (SPEC-V2 §5.1). This is the ONLY module that touches the table:
// everything else in payments/ goes through these functions, and nothing outside payments/ writes it.
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { PurchaseStatus } from '@vantra/shared';
import type { Db, DbLike, Tx } from '../db/client.js';
import { purchases, type NewPurchase, type PurchaseRow } from '../db/schema.js';

export const OPEN_STATUSES: readonly PurchaseStatus[] = ['pending', 'received'];

export type PurchasePatch = Partial<Omit<PurchaseRow, 'id' | 'createdAt'>>;

export async function insertPurchase(db: DbLike, values: NewPurchase): Promise<PurchaseRow> {
  const [row] = await db.insert(purchases).values(values).returning();
  return row!;
}

export async function loadPurchase(db: DbLike, id: string): Promise<PurchaseRow | null> {
  const [row] = await db.select().from(purchases).where(eq(purchases.id, id)).limit(1);
  return row ?? null;
}

export async function loadByClaimHash(db: DbLike, claimCodeHash: string): Promise<PurchaseRow | null> {
  const [row] = await db.select().from(purchases).where(eq(purchases.claimCodeHash, claimCodeHash)).limit(1);
  return row ?? null;
}

export async function updatePurchase(db: DbLike, id: string, patch: PurchasePatch): Promise<PurchaseRow> {
  const [row] = await db.update(purchases).set(patch).where(eq(purchases.id, id)).returning();
  if (!row) throw new Error(`purchase ${id} vanished during update`);
  return row;
}

/** Open purchases for one owner id, newest first — what `GET /api/me` shows as "in progress". */
export async function listOpenByOwner(db: DbLike, ownerId: string, limit = 25): Promise<PurchaseRow[]> {
  return db.select().from(purchases)
    .where(and(eq(purchases.ownerId, ownerId), inArray(purchases.status, [...OPEN_STATUSES])))
    .orderBy(desc(purchases.createdAt), desc(purchases.id)).limit(limit);
}

/** A name is reserved from checkout until the purchase stops being open (index: purchases_name_reserved_uq). */
export async function nameReserved(db: DbLike, name: string): Promise<boolean> {
  const [row] = await db.select({ id: purchases.id }).from(purchases)
    .where(and(eq(purchases.agentName, name), inArray(purchases.status, [...OPEN_STATUSES]))).limit(1);
  return !!row;
}

/** One poller batch: pending purchases whose per-purchase floor has elapsed, oldest first (§5.3). */
export async function duePurchases(db: DbLike, now: Date, minIntervalMs: number, limit: number): Promise<PurchaseRow[]> {
  const floor = new Date(now.getTime() - Math.max(0, minIntervalMs));
  return db.select().from(purchases)
    .where(and(
      eq(purchases.status, 'pending'),
      minIntervalMs > 0 ? or(isNull(purchases.lastPolledAt), lt(purchases.lastPolledAt, floor)) : undefined,
    ))
    .orderBy(asc(purchases.createdAt), asc(purchases.id)).limit(limit);
}

/** Purchases stuck between "money arrived" and "agent exists" — retried on every tick (§5.4.8). */
export async function stalledFulfilments(db: DbLike, maxAttempts: number, limit: number): Promise<PurchaseRow[]> {
  return db.select().from(purchases)
    .where(and(eq(purchases.status, 'received'), isNull(purchases.agentId), lt(purchases.spawnAttempts, maxAttempts)))
    .orderBy(asc(purchases.createdAt), asc(purchases.id)).limit(limit);
}

// Serialises everything that touches one purchase (receive, fulfil, cancel) for the rest of the
// enclosing transaction. Two pollers, a simulate-pay and a cancel can all race otherwise.
export async function lockPurchase(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`purchase:${id}`}))`);
}

/**
 * Applies `patch` to a purchase only while it is still in `expected`, inside one transaction holding
 * the advisory lock. Returns null when another worker got there first — the caller then does nothing.
 */
export async function transition(
  db: Db,
  id: string,
  expected: PurchaseStatus[],
  patch: PurchasePatch,
): Promise<PurchaseRow | null> {
  return db.transaction(async (tx) => {
    await lockPurchase(tx, id);
    const [current] = await tx.select().from(purchases).where(eq(purchases.id, id)).for('update').limit(1);
    if (!current || !expected.includes(current.status)) return null;
    const [row] = await tx.update(purchases).set(patch).where(eq(purchases.id, id)).returning();
    return row ?? null;
  });
}

export const countByStatus = async (db: DbLike, status: PurchaseStatus): Promise<number> => {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(purchases).where(eq(purchases.status, status));
  return row?.n ?? 0;
};

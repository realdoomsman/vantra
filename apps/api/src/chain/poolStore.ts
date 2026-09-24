// Persistence port for the treasury: the single `pool` row, `pool_txs`, `pool_snapshots` and the
// `treasury` feed events (SPEC-V2 §5.7 — the table names are kept, the meaning is the purchase
// treasury). pool.ts holds the accounting; this file holds the SQL.
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { FeedEvent, Micro, TreasuryTx, TreasuryTxKind } from '@vantra/shared';
import type { Clock } from '../core/interfaces.js';
import type { Db } from '../db/client.js';
import { agents, events, pool, poolSnapshots, poolTxs, type EventRow, type PoolRow } from '../db/schema.js';

export const TREASURY_ROW_ID = 1;
const MAX_TX_PAGE = 500;

export interface TreasuryTxInsert {
  ts?: Date;
  kind: TreasuryTxKind;
  amountMicro: Micro;
  txSig: string | null;
  agentId: string | null;
  meta?: Record<string, unknown>;
}
export interface TreasuryEventInsert { agentId: string | null; agentName: string | null; text: string; amountMicro: Micro | null }
export type TreasuryPatch = Partial<Omit<PoolRow, 'id'>>;

export interface TreasuryStore {
  load(walletPubkey: string, ethPriceUsd: number): Promise<PoolRow>;   // creates the singleton row; resets balances if the wallet changed
  update(patch: TreasuryPatch, txs: TreasuryTxInsert[], event?: TreasuryEventInsert): Promise<{ row: PoolRow; event: FeedEvent | null }>;  // one transaction
  hasPurchaseTx(purchaseId: string): Promise<boolean>;                 // fulfilment is retried: never book a purchase twice
  snapshot(day: string, usdcMicro: Micro, ethGwei: number): Promise<void>;
  listTxs(q: { limit: number; before?: number }): Promise<TreasuryTx[]>;
}

export function createTreasuryStore(db: Db, clock: Clock): TreasuryStore {
  return {
    async load(walletPubkey, ethPriceUsd) {
      const [created] = await db.insert(pool).values({ id: TREASURY_ROW_ID, walletPubkey, ethPriceUsd })
        .onConflictDoNothing().returning();
      if (created) return created;
      const [existing] = await db.select().from(pool).where(eq(pool.id, TREASURY_ROW_ID));
      if (existing!.walletPubkey === walletPubkey) return existing!;
      // The operator repointed the treasury: the recorded balances belong to the old wallet.
      const [moved] = await db.update(pool)
        .set({ walletPubkey, usdcMicro: 0, ethGwei: 0, lastSyncedAt: null })
        .where(eq(pool.id, TREASURY_ROW_ID)).returning();
      return moved!;
    },

    update(patch, txs, event) {
      return db.transaction(async (tx) => {
        const [row] = Object.keys(patch).length > 0
          ? await tx.update(pool).set(patch).where(eq(pool.id, TREASURY_ROW_ID)).returning()
          : await tx.select().from(pool).where(eq(pool.id, TREASURY_ROW_ID));
        if (!row) throw new Error('treasury row missing; call load() first');
        if (txs.length > 0) {
          await tx.insert(poolTxs).values(txs.map((t) => ({
            ts: t.ts ?? clock.now(), kind: t.kind, amountMicro: t.amountMicro, txSig: t.txSig, agentId: t.agentId,
            meta: t.meta ?? {},
          })));
        }
        let feed: FeedEvent | null = null;
        if (event) {
          const [inserted] = await tx.insert(events).values({ ts: clock.now(), kind: 'treasury', ...event }).returning();
          feed = toFeedEvent(inserted!);
        }
        return { row, event: feed };
      });
    },

    // `purchase` and `topup` rows both carry { purchaseId } in meta; a jsonb containment probe is what
    // makes a retried fulfilment (sweep recorded, spawn failed) unable to book the money twice.
    async hasPurchaseTx(purchaseId) {
      const [row] = await db.select({ id: poolTxs.id }).from(poolTxs)
        .where(and(
          inArray(poolTxs.kind, ['purchase', 'topup'] as TreasuryTxKind[]),
          sql`${poolTxs.meta} @> ${JSON.stringify({ purchaseId })}::jsonb`,
        ))
        .limit(1);
      return !!row;
    },

    async snapshot(day, usdcMicro, ethGwei) {
      await db.insert(poolSnapshots).values({ day, usdcMicro, ethGwei })
        .onConflictDoUpdate({ target: poolSnapshots.day, set: { usdcMicro, ethGwei } });
    },

    async listTxs({ limit, before }) {
      const rows = await db.select({
        id: poolTxs.id, ts: poolTxs.ts, kind: poolTxs.kind, amountMicro: poolTxs.amountMicro, txSig: poolTxs.txSig,
        agentId: poolTxs.agentId, agentName: agents.name,
      }).from(poolTxs).leftJoin(agents, eq(poolTxs.agentId, agents.id))
        .where(before === undefined ? undefined : lt(poolTxs.id, before))
        .orderBy(desc(poolTxs.id)).limit(Math.min(Math.max(1, limit), MAX_TX_PAGE));
      return rows.map((r) => ({ ...r, ts: r.ts.toISOString() }));
    },
  };
}

function toFeedEvent(row: EventRow): FeedEvent {
  return { id: row.id, ts: row.ts.toISOString(), kind: row.kind, agentId: row.agentId, agentName: row.agentName, text: row.text, amountMicro: row.amountMicro, meta: row.meta };
}

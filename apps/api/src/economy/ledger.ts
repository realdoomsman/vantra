// The ONLY writer of ledger rows and of agents.treasury/spend_*/revenue_*/royalty_*/unsettled aggregates.
// SPEC §7 invariant: agents.treasury_micro == balance_after_micro of the agent's latest ledger row.
import { and, asc, desc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import type { AgentPublic, LedgerEntry, LedgerKind, Micro, TreasuryPoint } from '@vantra/shared';
import type { CoreDeps } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import { agents, ledger, type AgentRow, type LedgerRow } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { liveSteps } from './live.js';
import { afterCommit, withTx } from './tx.js';

export interface LedgerInput {
  agentId: string;
  kind: LedgerKind;
  amountMicro: Micro;              // signed: spend negative, income positive
  memo: string;
  txSig?: string | null;
  counterparty?: string | null;
  meta?: Record<string, unknown>;
  settled?: boolean;               // default: false for protocol-owed spend and royalties, true otherwise
  ts?: Date;
}
export interface Posted { entry: LedgerEntry; row: LedgerRow; agent: AgentRow }

type SpendColumn = 'spendInferenceMicro' | 'spendComputeMicro' | 'spendRentMicro' | 'spendToolsMicro' | 'spendHostingMicro' | 'spendGasMicro';

// Spend owed to the protocol: accrues in unsettled_micro until the hourly sweep (§8.11).
export const PROTOCOL_SPEND_KINDS: Record<string, SpendColumn> = {
  inference: 'spendInferenceMicro', compute: 'spendComputeMicro', rent: 'spendRentMicro',
  tool: 'spendToolsMicro', hosting: 'spendHostingMicro', gas: 'spendGasMicro',
};
export const PROTOCOL_SPEND_KIND_LIST = Object.keys(PROTOCOL_SPEND_KINDS) as LedgerKind[];
const ROYALTY_KINDS: LedgerKind[] = ['royalty_in', 'royalty_out'];

export type LedgerDeps = Pick<CoreDeps, 'db' | 'clock' | 'bus'>;

export async function post(deps: LedgerDeps, db: DbLike, entry: LedgerInput): Promise<Posted> {
  return withTx(db, async (tx) => {
    const [row] = await tx.select().from(agents).where(eq(agents.id, entry.agentId)).for('update');
    if (!row) throw notFound('Agent');
    const ts = entry.ts ?? deps.clock.now();
    const balanceAfter = row.treasuryMicro + entry.amountMicro;
    const patch = aggregatePatch(row, entry);
    const [inserted] = await tx.insert(ledger).values({
      agentId: row.id, ts, kind: entry.kind, amountMicro: entry.amountMicro, balanceAfterMicro: balanceAfter,
      memo: entry.memo, txSig: entry.txSig ?? null, counterparty: entry.counterparty ?? null, meta: entry.meta ?? {},
      settled: entry.settled ?? defaultSettled(entry.kind),
    }).returning();
    await tx.update(agents).set({ treasuryMicro: balanceAfter, ...patch, updatedAt: ts }).where(eq(agents.id, row.id));
    const agent: AgentRow = { ...row, treasuryMicro: balanceAfter, ...patch, updatedAt: ts };
    const pub = toLedgerEntry(inserted!);
    afterCommit(tx, () => {
      deps.bus.emit({ type: 'ledger', entry: pub });
      deps.bus.emit({ type: 'agent', agentId: agent.id, patch: moneyPatch(agent) });
    });
    return { entry: pub, row: inserted!, agent };
  });
}

// Settlement sweep (SPEC §8.11): the accrued spend has already left the treasury, so the row is
// amount 0 — it only records that `sweptMicro` USDC moved to the protocol wallet and clears the
// unsettled aggregate. Kept here because nothing else may write `unsettled_micro`.
export async function postSettlement(
  deps: LedgerDeps,
  db: DbLike,
  p: { agentId: string; sweptMicro: Micro; txSig: string | null; counterparty: string; memo?: string; meta?: Record<string, unknown> },
): Promise<Posted> {
  return withTx(db, async (tx) => {
    const posted = await post(deps, tx, {
      agentId: p.agentId, kind: 'settlement', amountMicro: 0,
      memo: p.memo ?? `settled ${p.sweptMicro} micro-USDC to the protocol wallet`,
      txSig: p.txSig, counterparty: p.counterparty, settled: true,
      meta: { sweptMicro: p.sweptMicro, ...p.meta },
    });
    const remaining = Math.max(0, posted.agent.unsettledMicro - p.sweptMicro);
    await tx.update(agents).set({ unsettledMicro: remaining, lastSettledAt: deps.clock.now() }).where(eq(agents.id, p.agentId));
    await tx.update(ledger)
      .set({ settled: true })
      .where(and(eq(ledger.agentId, p.agentId), eq(ledger.settled, false), inArray(ledger.kind, PROTOCOL_SPEND_KIND_LIST), lte(ledger.id, posted.row.id)));
    return { ...posted, agent: { ...posted.agent, unsettledMicro: remaining, lastSettledAt: deps.clock.now() } };
  });
}

// Marks royalty rows paid once the child→parent transfer lands (settlement, SPEC §8.11).
export async function markRoyaltiesSettled(db: DbLike, agentId: string, upToId: number): Promise<void> {
  await db.update(ledger).set({ settled: true })
    .where(and(eq(ledger.agentId, agentId), eq(ledger.settled, false), inArray(ledger.kind, ROYALTY_KINDS), lte(ledger.id, upToId)));
}

// Marks exactly these rows paid. A parent with several forks must never have one child's payment
// settle a sibling's outstanding royalty_in, so the caller passes the ids it actually transferred.
export async function markRoyaltyRowsSettled(db: DbLike, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.update(ledger).set({ settled: true }).where(and(inArray(ledger.id, ids), eq(ledger.settled, false)));
}

// Unpaid royalty rows for one agent, oldest first.
export async function pendingRoyalties(db: DbLike, agentId: string, kind: 'royalty_in' | 'royalty_out'): Promise<LedgerRow[]> {
  return db.select().from(ledger)
    .where(and(eq(ledger.agentId, agentId), eq(ledger.kind, kind), eq(ledger.settled, false)))
    .orderBy(asc(ledger.id));
}

// The parent's unpaid royalty_in rows that came from ONE child (economy/fork.ts records the id in meta).
export async function pendingRoyaltiesFromChild(db: DbLike, parentId: string, childId: string): Promise<LedgerRow[]> {
  return db.select().from(ledger)
    .where(and(
      eq(ledger.agentId, parentId), eq(ledger.kind, 'royalty_in'), eq(ledger.settled, false),
      sql`${ledger.meta}->>'childAgentId' = ${childId}`,
    ))
    .orderBy(asc(ledger.id));
}

// Reclassifies an already-booked `revenue_pending` row as external revenue once evidence shows up
// (runtime/deposits.ts). The treasury does not move — only which revenue bucket the money sits in —
// so this is the one place allowed to shift those two aggregates.
export async function promotePendingToExternal(deps: LedgerDeps, db: DbLike, row: LedgerRow): Promise<AgentRow | null> {
  return withTx(db, async (tx) => {
    const [locked] = await tx.select().from(agents).where(eq(agents.id, row.agentId)).for('update');
    if (!locked) return null;
    const claimed = await tx.update(ledger)
      .set({ kind: 'revenue_external', memo: row.memo, meta: { ...row.meta, promotedFrom: 'revenue_pending' } })
      .where(and(eq(ledger.id, row.id), eq(ledger.kind, 'revenue_pending')))
      .returning({ id: ledger.id });
    if (claimed.length === 0) return null;                 // another writer promoted it first
    const amount = Math.abs(row.amountMicro);
    const patch = {
      revenuePendingMicro: Math.max(0, locked.revenuePendingMicro - amount),
      revenueExternalMicro: locked.revenueExternalMicro + amount,
      updatedAt: deps.clock.now(),
    };
    await tx.update(agents).set(patch).where(eq(agents.id, locked.id));
    const agent: AgentRow = { ...locked, ...patch };
    afterCommit(tx, () => deps.bus.emit({ type: 'agent', agentId: agent.id, patch: moneyPatch(agent) }));
    return agent;
  });
}

function defaultSettled(kind: LedgerKind): boolean {
  return !(kind in PROTOCOL_SPEND_KINDS) && !ROYALTY_KINDS.includes(kind);
}

// Column increments per kind (AMENDMENTS C20). Returns only the columns that change.
function aggregatePatch(row: AgentRow, e: LedgerInput): Partial<AgentRow> {
  const abs = Math.abs(e.amountMicro);
  const spend = PROTOCOL_SPEND_KINDS[e.kind];
  if (spend) return { [spend]: row[spend] + abs, unsettledMicro: row.unsettledMicro + abs };
  switch (e.kind) {
    case 'funding': return { fundingMicro: row.fundingMicro + abs };
    case 'revenue_external': return { revenueExternalMicro: row.revenueExternalMicro + abs };
    case 'revenue_internal': return { revenueInternalMicro: row.revenueInternalMicro + abs };
    case 'revenue_pending': return { revenuePendingMicro: row.revenuePendingMicro + abs };
    case 'escrow_in':
      return e.meta?.revenueClass === 'external'
        ? { revenueExternalMicro: row.revenueExternalMicro + abs }
        : { revenueInternalMicro: row.revenueInternalMicro + abs };
    case 'payment':
    case 'escrow_out': return { spendPaymentsMicro: row.spendPaymentsMicro + abs };
    case 'refund': return { spendPaymentsMicro: row.spendPaymentsMicro - abs };
    case 'withdrawal': return { withdrawnMicro: row.withdrawnMicro + abs };
    case 'recapitalize': return { recapitalizedMicro: row.recapitalizedMicro + abs };
    case 'royalty_in': return { royaltyInMicro: row.royaltyInMicro + abs };
    case 'royalty_out': return { royaltyOutMicro: row.royaltyOutMicro + abs };
    // x402: the agent already paid the gateway on-chain, so it counts as inference spend but is NOT
    // owed to the protocol — it never touches unsettled_micro and is settled on arrival.
    case 'inference_paid': return { spendInferenceMicro: row.spendInferenceMicro + abs };
    // Protocol spend is handled above; these carry no aggregate of their own.
    // trade: only liquid treasury moves; realized P&L is booked to tradeRealizedMicro by the trade tool.
    case 'trade': return { tradeVolumeMicro: row.tradeVolumeMicro + abs };
    case 'creator_reward': return { creatorRewardMicro: row.creatorRewardMicro + abs };
    case 'inference': case 'compute': case 'rent': case 'tool': case 'hosting': case 'gas':
    case 'withdrawal_fee': case 'settlement': return {};
    // buyback: stablecoin a launched agent spent buying its own coin back to burn it. The balance moves
    // like any debit (post() sets treasury_micro from the signed amount, never from these counters);
    // it is a distribution to the coin's holders, not spend and not revenue, so it stays out of
    // profit, out of unsettled and out of the burn rate. The burns table is its running total.
    case 'buyback': return {};
  }
}

// AMENDMENTS C20 plus `revenuePendingMicro`: unattributed inflows are real money in the treasury, so
// leaving them out would make profit disagree with the balance the ledger reports.
export function profitOf(a: AgentRow): Micro {
  return a.revenueExternalMicro + a.revenueInternalMicro + a.revenuePendingMicro + a.royaltyInMicro + a.tradeRealizedMicro
    - (a.spendInferenceMicro + a.spendComputeMicro + a.spendRentMicro + a.spendToolsMicro + a.spendHostingMicro
      + a.spendGasMicro + a.spendPaymentsMicro + a.royaltyOutMicro);
}

// Cheap WS patch after a ledger post: every money column plus derived money fields.
export function moneyPatch(a: AgentRow): Partial<AgentPublic> {
  return {
    treasuryMicro: a.treasuryMicro, fundingMicro: a.fundingMicro,
    revenueExternalMicro: a.revenueExternalMicro, revenueInternalMicro: a.revenueInternalMicro,
    revenuePendingMicro: a.revenuePendingMicro,
    spendInferenceMicro: a.spendInferenceMicro, spendComputeMicro: a.spendComputeMicro, spendToolsMicro: a.spendToolsMicro,
    spendHostingMicro: a.spendHostingMicro, spendRentMicro: a.spendRentMicro, spendGasMicro: a.spendGasMicro,
    spendPaymentsMicro: a.spendPaymentsMicro, royaltyInMicro: a.royaltyInMicro, royaltyOutMicro: a.royaltyOutMicro,
    recapitalizedMicro: a.recapitalizedMicro, withdrawnMicro: a.withdrawnMicro, unsettledMicro: a.unsettledMicro,
    profitMicro: profitOf(a), paidBack: a.fundingMicro > 0 && a.revenueExternalMicro >= a.fundingMicro,
    stepping: liveSteps.get(a.id) !== null,
  };
}

export function toLedgerEntry(r: LedgerRow): LedgerEntry {
  return {
    id: r.id, agentId: r.agentId, ts: r.ts.toISOString(), kind: r.kind, amountMicro: r.amountMicro,
    balanceAfterMicro: r.balanceAfterMicro, memo: r.memo, txSig: r.txSig, counterparty: r.counterparty, meta: r.meta,
  };
}

export async function listLedger(db: DbLike, agentId: string, q: { limit: number; before?: number }): Promise<LedgerEntry[]> {
  const where = q.before ? and(eq(ledger.agentId, agentId), lt(ledger.id, q.before)) : eq(ledger.agentId, agentId);
  const rows = await db.select().from(ledger).where(where).orderBy(desc(ledger.id)).limit(q.limit);
  return rows.map(toLedgerEntry);
}


// Treasury over time, downsampled to at most `maxPoints` (always keeps the latest row).
export async function treasurySeries(db: DbLike, agentId: string, maxPoints = 240): Promise<TreasuryPoint[]> {
  const rows = await db.select({ ts: ledger.ts, balance: ledger.balanceAfterMicro }).from(ledger).where(eq(ledger.agentId, agentId)).orderBy(asc(ledger.id));
  if (rows.length <= maxPoints) return rows.map((r) => ({ ts: r.ts.toISOString(), treasuryMicro: r.balance }));
  const stride = rows.length / (maxPoints - 1);
  const picked: TreasuryPoint[] = [];
  for (let i = 0; i < maxPoints - 1; i++) {
    const r = rows[Math.floor(i * stride)]!;
    picked.push({ ts: r.ts.toISOString(), treasuryMicro: r.balance });
  }
  const last = rows[rows.length - 1]!;
  picked.push({ ts: last.ts.toISOString(), treasuryMicro: last.balance });
  return picked;
}

// Incoming USDC classification (SPEC §8.7). Every unseen inflow to an agent wallet becomes exactly one
// ledger row; external revenue also drives milestones and fork royalties.
//
// SPEC §8.7 books "anything else" as external revenue. That makes the protocol's headline metric —
// and with it the seed-payback milestone, the fork royalty and the withdrawal gate — forgeable for the
// price of a second keypair, so external revenue is DEFAULT-DENY here: an inflow is only promoted when
// something ties it to a customer outside the agent population (a user-paid service call, a bounty a
// non-owner posted, or a wallet the operator allow-listed). Everything else lands as `revenue_pending`:
// real money the agent can spend, counted nowhere that claims the business works.
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  MILESTONES_MICRO, fmtUsd,
  type DepositClass, type LedgerKind, type Micro,
} from '@vantra/shared';
import type { CoreDeps, UsdcInflow } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import {
  agents, bounties, depositsSeen, ledger, projects, serviceCalls, services, users,
  type AgentRow, type BountyRow,
} from '../db/schema.js';
import { addEvent, shortWallet } from '../economy/events.js';
import { accrueRoyalty } from '../economy/fork.js';
import { post, promotePendingToExternal } from '../economy/ledger.js';
import { lockAgent } from '../economy/repo.js';
import { withTx } from '../economy/tx.js';
import { wallets } from '../economy/wallets.js';
import { wakeSoon } from './wake.js';

export const DEPOSIT_SCAN_LIMIT = 50;
export const PENDING_PROMOTION_LIMIT = 20;
const MEMO_TEXT_MAX_CHARS = 90;

export interface Deposit {
  sig: string; from: string; amountMicro: Micro; classified: DepositClass; kind: LedgerKind; memo: string; ts: Date;
}
export interface DepositScan { agent: AgentRow; deposits: Deposit[] }

type Deps = CoreDeps;

// Reads the chain, books everything unseen, refreshes the cached on-chain balance.
export async function scanDeposits(deps: Deps, agent: AgentRow): Promise<DepositScan> {
  const now = deps.clock.now();
  let inflows: UsdcInflow[];
  let onchain: Micro;
  try {
    [inflows, onchain] = await Promise.all([
      deps.chain.listUsdcInflows(agent.walletPubkey, agent.lastDepositSig, DEPOSIT_SCAN_LIMIT),
      deps.chain.getUsdcBalance(agent.walletPubkey),
    ]);
  } catch (e) {
    deps.log.warn({ err: e, agentId: agent.id }, 'deposit scan failed; continuing with the last known balance');
    return { agent, deposits: [] };
  }

  const fresh = await unseen(deps.db, inflows);
  const deposits: Deposit[] = [];
  let current = agent;
  for (const inflow of fresh) {
    const booked = await bookDeposit(deps, current, inflow);
    if (!booked) continue;                                  // a concurrent scan claimed the transaction
    current = booked.agent;
    deposits.push(booked.deposit);
  }
  current = await promotePending(deps, current);
  // Money arriving from outside is the one thing that lengthens a life, so the agent gets to react
  // to it now rather than at its next scheduled heartbeat (SPEC-V2 §7.4).
  if (deposits.some((d) => d.kind === 'revenue_external' || d.kind === 'revenue_pending')) {
    wakeSoon(deps, agent.id, 'deposit');
  }

  if (inflows.length >= DEPOSIT_SCAN_LIMIT) {
    deps.log.warn({ agentId: agent.id, scanned: inflows.length }, 'deposit page was full; older inflows may need a manual reconcile');
  }
  // `listUsdcInflows` returns newest-first and stops at `sinceSig`, so element 0 is the newest hash on
  // chain and everything unseen behind it is booked above: that hash is the next cursor. One inflow per
  // transaction is what makes it a usable cursor at all — `deposits_seen` is keyed by it.
  const lastSig = inflows[0]?.sig ?? agent.lastDepositSig;
  const [row] = await deps.db.update(agents)
    .set({ lastDepositSig: lastSig, onchainUsdcMicro: onchain, onchainCheckedAt: now })
    .where(eq(agents.id, agent.id)).returning();
  return { agent: row ?? current, deposits };
}

// Oldest first, dropping anything already in deposits_seen. This is a cheap filter only: the insert
// inside bookDeposit is what actually guarantees one ledger row per transaction.
async function unseen(db: DbLike, inflows: UsdcInflow[]): Promise<UsdcInflow[]> {
  if (inflows.length === 0) return [];
  const rows = await db.select({ sig: depositsSeen.sig }).from(depositsSeen).where(inArray(depositsSeen.sig, inflows.map((i) => i.sig)));
  const seen = new Set(rows.map((r) => r.sig));
  return inflows.filter((i) => !seen.has(i.sig)).reverse();
}

async function bookDeposit(deps: Deps, agent: AgentRow, inflow: UsdcInflow): Promise<{ agent: AgentRow; deposit: Deposit } | null> {
  const classified = await classify(deps, agent, inflow);
  return withTx(deps.db, async (tx) => {
    // Claim the transaction hash BEFORE posting, in the same transaction: two overlapping scans (a heartbeat
    // and a recapitalize, say) would otherwise both read it as unseen and credit the treasury twice.
    await lockAgent(tx, agent.id);
    const claimed = await tx.insert(depositsSeen).values({
      sig: inflow.sig, agentId: agent.id, fromWallet: inflow.from, amountMicro: inflow.amount,
      ts: inflow.ts, classified: classified.classified,
    }).onConflictDoNothing({ target: depositsSeen.sig }).returning({ sig: depositsSeen.sig });
    if (claimed.length === 0) return null;

    const externalBefore = agent.revenueExternalMicro;
    const { agent: after } = await post(deps, tx, {
      agentId: agent.id, kind: classified.kind, amountMicro: inflow.amount, memo: classified.memo,
      txSig: inflow.sig, counterparty: inflow.from, ts: inflow.ts, settled: true,
      meta: { classified: classified.classified, revenueClass: classified.revenueClass, ...classified.meta },
    });

    let current = after;
    if (classified.revenueClass !== null) {
      await creditProject(tx, agent.id, inflow.amount, inflow.ts);
      await addEvent(deps, tx, {
        kind: 'revenue', agentId: agent.id, agentName: agent.name, amountMicro: inflow.amount, ts: inflow.ts,
        text: `${agent.name} earned ${fmtUsd(inflow.amount)} (${classified.revenueClass}) — ${classified.memo}`,
        meta: { classified: classified.classified, txSig: inflow.sig },
      });
    }
    if (classified.classified === 'owner') {
      await addEvent(deps, tx, {
        kind: 'recapitalize', agentId: agent.id, agentName: agent.name, amountMicro: inflow.amount, ts: inflow.ts,
        text: `${agent.name} was recapitalized with ${fmtUsd(inflow.amount)} by its owner`,
        meta: { txSig: inflow.sig },
      });
    }
    if (classified.revenueClass === 'external') {
      current = await onExternalRevenue(deps, tx, current, externalBefore, inflow.amount, inflow.ts);
    }
    const deposit: Deposit = {
      sig: inflow.sig, from: inflow.from, amountMicro: inflow.amount, classified: classified.classified,
      kind: classified.kind, memo: classified.memo, ts: inflow.ts,
    };
    return { agent: current, deposit };
  });
}

// Everything that must happen exactly once per dollar of external revenue, whether it was recognised
// at book time or promoted later: milestones (SPEC §8.7) and the fork royalty accrual.
async function onExternalRevenue(
  deps: Deps, tx: DbLike, agent: AgentRow, externalBefore: Micro, amountMicro: Micro, ts: Date,
): Promise<AgentRow> {
  await milestones(deps, tx, agent, externalBefore, ts);
  const royalty = await accrueRoyalty(deps, tx, agent, amountMicro);
  if (royalty <= 0) return agent;
  const [refreshed] = await tx.select().from(agents).where(eq(agents.id, agent.id));
  return refreshed ?? agent;
}

// A buyer pays, then calls: if the agent's heartbeat lands between the two, the deposit is booked with
// no evidence yet. Re-check the recent pending rows each scan so a real customer is not lost to a race.
async function promotePending(deps: Deps, agent: AgentRow): Promise<AgentRow> {
  const rows = await deps.db.select().from(ledger)
    .where(and(eq(ledger.agentId, agent.id), eq(ledger.kind, 'revenue_pending'), isNotNull(ledger.txSig)))
    .orderBy(desc(ledger.id)).limit(PENDING_PROMOTION_LIMIT);
  let current = agent;
  for (const row of rows) {
    const evidence = await externalEvidence(deps, current, row.counterparty ?? '', row.txSig!);
    if (!evidence) continue;
    const amountMicro = Math.abs(row.amountMicro);
    current = await withTx(deps.db, async (tx) => {
      const before = current.revenueExternalMicro;
      const promoted = await promotePendingToExternal(deps, tx, { ...row, memo: evidence.memo, meta: { ...row.meta, ...evidence.meta } });
      if (!promoted) return current;
      await creditProject(tx, promoted.id, amountMicro, row.ts);
      await addEvent(deps, tx, {
        kind: 'revenue', agentId: promoted.id, agentName: promoted.name, amountMicro, ts: row.ts,
        text: `${promoted.name} earned ${fmtUsd(amountMicro)} (external) — ${evidence.memo}`,
        meta: { classified: 'external', txSig: row.txSig, promoted: true },
      });
      deps.log.info({ agentId: promoted.id, ledgerId: row.id, evidence: evidence.meta['evidence'] }, 'pending deposit promoted to external revenue');
      return onExternalRevenue(deps, tx, promoted, before, amountMicro, row.ts);
    });
  }
  return current;
}

interface Classification {
  classified: DepositClass;
  kind: LedgerKind;
  memo: string;
  revenueClass: 'external' | 'internal' | null;
  meta?: Record<string, unknown>;
}

async function classify(deps: Deps, agent: AgentRow, inflow: UsdcInflow): Promise<Classification> {
  const protocol = wallets(deps);
  if (inflow.from === protocol.treasury.pubkey) {
    return agent.fundingMicro === 0
      ? { classified: 'pool', kind: 'funding', memo: 'purchase funding from the treasury', revenueClass: null }
      : { classified: 'pool', kind: 'recapitalize', memo: 'top-up from the treasury', revenueClass: null };
  }
  if (inflow.from === protocol.escrow.pubkey) return classifyEscrow(deps, agent, inflow);
  // A claim owner's id is never a pubkey, so without the payout-wallet match their own top-up would
  // book as `revenue_pending` (SPEC-V2 §6.2).
  if (await isOwnerWallet(deps.db, agent, inflow.from)) {
    return { classified: 'owner', kind: 'recapitalize', memo: 'owner top-up', revenueClass: null };
  }
  const sender = await agentByWallet(deps.db, inflow.from);
  if (sender) {
    const match = await matchServiceCall(deps.db, agent.id, sender.id, inflow.amount);
    return {
      classified: 'internal', kind: 'revenue_internal', revenueClass: 'internal',
      memo: match ? `service "${match}" paid by ${sender.name}` : `transfer from ${sender.name}`,
      meta: { fromAgentId: sender.id },
    };
  }

  const evidence = await externalEvidence(deps, agent, inflow.from, inflow.sig);
  if (evidence) {
    return { classified: 'external', kind: 'revenue_external', revenueClass: 'external', memo: evidence.memo, meta: evidence.meta };
  }
  return {
    classified: 'pending', kind: 'revenue_pending', revenueClass: null,
    memo: `unattributed transfer from ${shortWallet(inflow.from)} — not counted as external revenue`,
    meta: { evidence: null },
  };
}

interface ExternalEvidence { memo: string; meta: Record<string, unknown> }

// The only two ways an inflow becomes external revenue, besides a user-posted bounty payout:
//  1. the operator allow-listed the payer (a merchant of record, a settlement wallet, the demo's customers);
//  2. the tx hash is the payment_tx of a `service_calls` row this agent served for a `user` buyer,
//     and that buyer does not itself own an agent (SPEC: external means outside the agent population).
async function externalEvidence(deps: Deps, agent: AgentRow, from: string, sig: string): Promise<ExternalEvidence | null> {
  if (from !== '' && deps.config.economy.externalPayers.includes(from)) {
    return { memo: `external customer payment from ${shortWallet(from)}`, meta: { evidence: 'allowlist' } };
  }
  const call = await matchUserPayment(deps.db, agent.id, sig);
  if (!call) return null;
  if (await isOwnerWallet(deps.db, agent, from) || (from !== '' && await ownsAnyAgent(deps.db, from))) return null;
  return {
    memo: `service "${memoText(call.serviceName)}" paid by ${shortWallet(from)}`,
    meta: { evidence: 'service_call', serviceId: call.serviceId, callId: call.callId },
  };
}

async function classifyEscrow(deps: Deps, agent: AgentRow, inflow: UsdcInflow): Promise<Classification> {
  const refunded = await matchRefund(deps.db, agent.id, inflow.amount);
  if (refunded) {
    return {
      classified: 'escrow', kind: 'refund', revenueClass: null,
      memo: `escrow refund: ${memoText(refunded.title)}`, meta: { bountyId: refunded.id },
    };
  }
  const bounty = await matchBounty(deps.db, agent.id, inflow.amount);
  // A human poster who is also this agent's owner is self-dealing, not a customer.
  const external = bounty?.posterType === 'user' && !(await isOwnerWallet(deps.db, agent, bounty.posterId));
  return {
    classified: 'escrow', kind: 'escrow_in', revenueClass: external ? 'external' : 'internal',
    memo: bounty ? `bounty payout: ${memoText(bounty.title)}` : 'escrow payout',
    meta: { bountyId: bounty?.id ?? null, posterType: bounty?.posterType ?? null },
  };
}

// Nothing on chain says which project a payment was for, so revenue is attributed to the project the
// agent is currently selling: the most recently updated live one, or its newest project otherwise.
// This is what makes `Project.revenueMicro` (SPEC §4) and the `operating` phase (C20) mean something.
async function creditProject(db: DbLike, agentId: string, amountMicro: Micro, ts: Date): Promise<void> {
  const [target] = await db.select({ id: projects.id }).from(projects)
    .where(eq(projects.agentId, agentId))
    .orderBy(sql`(${projects.status} = 'live') desc`, desc(projects.updatedAt))
    .limit(1);
  if (!target) return;
  await db.update(projects)
    .set({ revenueMicro: sql`${projects.revenueMicro} + ${amountMicro}`, updatedAt: ts })
    .where(eq(projects.id, target.id));
}

async function agentByWallet(db: DbLike, pubkey: string): Promise<{ id: string; name: string } | null> {
  const [row] = await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.walletPubkey, pubkey)).limit(1);
  return row ?? null;
}

// Is this sender the agent's own owner? A wallet owner's id IS their pubkey; a claim owner has no
// pubkey of its own, so the payout wallet they registered is the only thing that identifies them.
async function isOwnerWallet(db: DbLike, agent: AgentRow, from: string): Promise<boolean> {
  if (from === '') return false;
  if (from === agent.ownerWallet) return true;
  const [row] = await db.select({ payoutWallet: users.payoutWallet }).from(users)
    .where(eq(users.wallet, agent.ownerWallet)).limit(1);
  return row?.payoutWallet === from;
}

// The set of wallets that run an agent — by owner id or by the payout wallet they registered. A
// deposit from one of them is inside the population however it was routed, so it never counts as
// external revenue (this is what stops two owners washing for free).
async function ownsAnyAgent(db: DbLike, wallet: string): Promise<boolean> {
  const [owned] = await db.select({ wallet: agents.ownerWallet }).from(agents).where(eq(agents.ownerWallet, wallet)).limit(1);
  if (owned !== undefined) return true;
  const [payout] = await db.select({ wallet: users.wallet }).from(users)
    .innerJoin(agents, eq(agents.ownerWallet, users.wallet))
    .where(eq(users.payoutWallet, wallet)).limit(1);
  return payout !== undefined;
}

// A bounty this agent already has a booked escrow row for cannot also explain a second inflow.
const notAlreadyBooked = (agentId: string) => sql`not exists (
  select 1 from ${ledger}
  where ${ledger.agentId} = ${agentId} and ${ledger.kind} in ('escrow_in', 'refund')
    and ${ledger.meta}->>'bountyId' = ${bounties.id}
)`;

// Escrow payouts carry no memo on chain, so the bounty is matched by claimer + exact reward. Only a
// bounty that was actually approved can have paid out.
async function matchBounty(db: DbLike, claimerAgentId: string, amount: Micro): Promise<BountyRow | null> {
  const [row] = await db.select().from(bounties)
    .where(and(
      eq(bounties.claimerAgentId, claimerAgentId), eq(bounties.rewardMicro, amount), eq(bounties.status, 'paid'),
      notAlreadyBooked(claimerAgentId),
    ))
    .orderBy(sql`${bounties.paidAt} desc nulls last`, desc(bounties.createdAt)).limit(1);
  return row ?? null;
}

// Escrow money coming back for a bounty this agent posted is a refund, never revenue — but only the
// expiry sweep ever sends one, and only for a funded bounty it moved to `expired`. A `rejected` bounty
// still holds its reward in escrow (the claimer may resubmit), so matching it here used to book a
// genuine payout for some OTHER bounty as a refund and silently erase external revenue.
async function matchRefund(db: DbLike, posterAgentId: string, amount: Micro): Promise<BountyRow | null> {
  const [row] = await db.select().from(bounties)
    .where(and(
      eq(bounties.posterType, 'agent'), eq(bounties.posterId, posterAgentId), eq(bounties.rewardMicro, amount),
      inArray(bounties.status, ['expired', 'cancelled']), isNotNull(bounties.escrowTx),
      notAlreadyBooked(posterAgentId),
    ))
    .orderBy(desc(bounties.createdAt)).limit(1);
  return row ?? null;
}

async function matchServiceCall(db: DbLike, sellerAgentId: string, buyerAgentId: string, amount: Micro): Promise<string | null> {
  const [row] = await db.select({ name: services.name }).from(serviceCalls)
    .innerJoin(services, eq(services.id, serviceCalls.serviceId))
    .where(and(eq(services.agentId, sellerAgentId), eq(serviceCalls.buyerType, 'agent'), eq(serviceCalls.buyerId, buyerAgentId), eq(serviceCalls.priceMicro, amount)))
    .orderBy(desc(serviceCalls.id)).limit(1);
  return row?.name ?? null;
}

// The exact payment transaction hash a human buyer handed to POST /svc or /api/market/services/:id/call.
interface UserPayment { callId: number; serviceId: string; serviceName: string }
async function matchUserPayment(db: DbLike, sellerAgentId: string, sig: string): Promise<UserPayment | null> {
  if (!sig) return null;
  const [row] = await db.select({ callId: serviceCalls.id, serviceId: services.id, serviceName: services.name })
    .from(serviceCalls).innerJoin(services, eq(services.id, serviceCalls.serviceId))
    // Only a call the seller was actually paid for: a failed one is refunded (hosting/service.ts), so
    // promoting it would book external revenue the agent no longer holds.
    .where(and(eq(services.agentId, sellerAgentId), eq(serviceCalls.buyerType, 'user'), eq(serviceCalls.paymentTx, sig),
      eq(serviceCalls.status, 'ok')))
    .orderBy(desc(serviceCalls.id)).limit(1);
  return row ?? null;
}

// Third-party text (bounty titles, service names) reaches the agent's STATUS block through memos.
// Angle brackets are stripped so it can never forge the <untrusted> framing the model is told to obey.
const memoText = (s: string): string => {
  const flat = s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > MEMO_TEXT_MAX_CHARS ? `${flat.slice(0, MEMO_TEXT_MAX_CHARS - 1)}…` : flat;
};

// $1 / $10 / $100 / $1k crossings plus the moment external revenue covers the seed (SPEC §8.7).
async function milestones(deps: Deps, db: DbLike, agent: AgentRow, before: Micro, ts: Date): Promise<void> {
  const after = agent.revenueExternalMicro;
  for (const level of MILESTONES_MICRO) {
    if (before < level && after >= level) {
      await addEvent(deps, db, {
        kind: 'milestone', agentId: agent.id, agentName: agent.name, amountMicro: after, ts,
        text: `${agent.name} passed ${fmtUsd(level)} in external revenue`, meta: { level },
      });
    }
  }
  if (agent.fundingMicro > 0 && before < agent.fundingMicro && after >= agent.fundingMicro) {
    await addEvent(deps, db, {
      kind: 'milestone', agentId: agent.id, agentName: agent.name, amountMicro: after, ts,
      text: `${agent.name} PAID BACK WHAT IT COST (${fmtUsd(after)} external revenue vs ${fmtUsd(agent.fundingMicro)} paid for it)`,
      meta: { fundingMicro: agent.fundingMicro },
    });
  }
}

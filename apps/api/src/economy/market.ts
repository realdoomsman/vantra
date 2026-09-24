// The market (SPEC §8.9 bounties, §8.15 market routes): human-posted bounties with on-chain escrow,
// human review of submissions, paid service calls and the bounty-expiry sweep.
import { and, desc, eq, inArray, lte, or } from 'drizzle-orm';
import {
  fmtUsd, type Bounty, type BountyStatus, type Micro, type Service,
} from '@vantra/shared';
import { verifyUsdcTransfer } from '../chain/verify.js';
import type { CoreDeps, ServiceBuyer } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import { createServiceRunner, createServiceStore, type ServiceCaller, type ServiceRunner } from '../hosting/service.js';
import { agents, bounties, depositsSeen, services, type BountyRow } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound, uniqueViolation } from '../lib/errors.js';
import { newBountyId } from '../lib/ids.js';
import { agentNames } from './agents.js';
import { addEvent } from './events.js';
import { post } from './ledger.js';
import { toBounty, toService } from './mappers.js';
import { hostingLedgerHook, hostingRefund } from './ports.js';
import { wakeBountyFanout, wakeSoon } from '../runtime/wake.js';
import { withTx } from './tx.js';
import { transferFromEscrow, wallets } from './wallets.js';

export const MIN_BOUNTY_REWARD_MICRO = 50_000;      // $0.05, same floor as the post_bounty tool
export const MIN_DEADLINE_HOURS = 1;
export const MAX_DEADLINE_HOURS = 336;
export const MAX_REJECTIONS = 2;                    // one resubmission, then the bounty reopens

type Deps = CoreDeps;

export interface PostBountyInput {
  posterType: 'user'; posterWallet: string; title: string; description: string;
  rewardMicro: Micro; deadlineHours: number; escrowTxSig: string;
}

export async function listBounties(deps: Deps, status?: BountyStatus): Promise<Bounty[]> {
  const rows = await deps.db.select().from(bounties)
    .where(status ? eq(bounties.status, status) : undefined)
    .orderBy(desc(bounties.createdAt)).limit(200);
  return withNames(deps, rows);
}

export async function listServices(deps: Deps): Promise<Service[]> {
  const rows = await deps.db.select({ service: services, agentName: agents.name, agentWallet: agents.walletPubkey })
    .from(services).innerJoin(agents, eq(agents.id, services.agentId))
    .orderBy(desc(services.revenueMicro), desc(services.createdAt)).limit(200);
  return rows.map(({ service, agentName, agentWallet }) => toService(deps.config, service, agentName, agentWallet));
}

// The caller escrows the reward on chain first; we verify that transfer before the bounty exists.
export async function postBounty(deps: Deps, input: PostBountyInput): Promise<Bounty> {
  const title = input.title.trim();
  const description = input.description.trim();
  if (title.length < 3) throw badRequest('Bounty title is too short');
  if (!description) throw badRequest('Bounty description is required');
  if (input.rewardMicro < MIN_BOUNTY_REWARD_MICRO) throw badRequest(`Minimum reward is ${fmtUsd(MIN_BOUNTY_REWARD_MICRO)}`);
  if (input.deadlineHours < MIN_DEADLINE_HOURS || input.deadlineHours > MAX_DEADLINE_HOURS) {
    throw badRequest(`Deadline must be between ${MIN_DEADLINE_HOURS} and ${MAX_DEADLINE_HOURS} hours`);
  }
  const transfer = await verifyUsdcTransfer(deps.chain, input.escrowTxSig, {
    to: wallets(deps).escrow.pubkey, from: input.posterWallet, minAmount: input.rewardMicro, what: 'escrow transfer',
  });

  const now = deps.clock.now();
  const id = newBountyId();
  // The INSERT is the guard, not a prior SELECT: approval pays the claimer out of the SHARED escrow
  // wallet, so N concurrent posts carrying one deposit would pay out N × reward of other posters'
  // money. `bounties_escrow_tx_uq` closes the window a read-then-insert leaves open.
  const row = await withTx(deps.db, async (tx) => {
    const [created] = await insertBounty(tx, {
      id, posterType: 'user', posterId: input.posterWallet, title, description, rewardMicro: input.rewardMicro,
      status: 'open', createdAt: now, deadlineAt: new Date(now.getTime() + input.deadlineHours * 3_600_000),
      escrowTx: transfer.sig,
    });
    await addEvent(deps, tx, {
      kind: 'bounty', amountMicro: input.rewardMicro, ts: now,
      text: `New bounty: "${title}" for ${fmtUsd(input.rewardMicro)}`,
      meta: { bountyId: id, posterType: 'user' },
    });
    return created!;
  });
  // A bounty nobody sees before it is claimed is worth nothing, so the agents that could work it are
  // pulled forward instead of waiting out their heartbeats (SPEC-V2 §7.4).
  wakeBountyFanout(deps, row.id);
  return (await withNames(deps, [row]))[0]!;
}

type NewBounty = typeof bounties.$inferInsert;

async function insertBounty(tx: DbLike, values: NewBounty): Promise<BountyRow[]> {
  try {
    return await tx.insert(bounties).values(values).returning();
  } catch (e) {
    if (uniqueViolation(e) !== null) throw conflict('INVALID_TX', 'That escrow transaction already funds another bounty');
    throw e;
  }
}

// Human review of a human-posted bounty (SPEC §8.9). Approval pays the claimer out of escrow.
export async function reviewBounty(deps: Deps, bountyId: string, posterWallet: string, approve: boolean, feedback: string): Promise<Bounty> {
  const [row] = await deps.db.select().from(bounties).where(eq(bounties.id, bountyId));
  if (!row) throw notFound('Bounty');
  if (row.posterType !== 'user' || row.posterId !== posterWallet) throw forbidden('Only the poster can review this bounty');
  if (row.status !== 'submitted') throw conflict('NOT_ELIGIBLE', `Bounty is ${row.status}, not submitted`);
  if (!row.claimerAgentId) throw conflict('NOT_ELIGIBLE', 'Bounty has no claimer');

  const [claimer] = await deps.db.select().from(agents).where(eq(agents.id, row.claimerAgentId));
  if (!claimer) throw notFound('Claimer agent');
  const now = deps.clock.now();
  const note = feedback.trim().slice(0, 2_000);

  if (!approve) {
    const rejections = row.rejections + 1;
    const reopened = rejections >= MAX_REJECTIONS;
    const [updated] = await deps.db.update(bounties).set({
      status: reopened ? 'open' : 'claimed', rejections, feedback: note,
      claimerAgentId: reopened ? null : row.claimerAgentId, submission: reopened ? null : row.submission,
      claimedAt: reopened ? null : row.claimedAt,
    }).where(eq(bounties.id, bountyId)).returning();
    await withTx(deps.db, (tx) => addEvent(deps, tx, {
      kind: 'bounty', agentId: claimer.id, agentName: claimer.name, ts: now,
      text: reopened
        ? `"${row.title}" was rejected again and is open for anyone to claim`
        : `${claimer.name}'s submission for "${row.title}" was rejected — one resubmission left`,
      meta: { bountyId, rejections },
    }));
    return (await withNames(deps, [updated!]))[0]!;
  }

  // The row is marked paid before the transfer: a crash in between leaves an unpaid bounty an operator
  // can settle by hand, which is safer than a retry paying the claimer twice.
  const [paid] = await deps.db.update(bounties)
    .set({ status: 'paid', paidAt: now, feedback: note })
    .where(eq(bounties.id, bountyId)).returning();
  let sig: string;
  try {
    sig = await transferFromEscrow(deps, claimer.walletPubkey, row.rewardMicro, `bounty ${bountyId}`);
  } catch (e) {
    await deps.db.update(bounties).set({ status: 'submitted', paidAt: null }).where(eq(bounties.id, bountyId));
    throw e;
  }
  await withTx(deps.db, (tx) => addEvent(deps, tx, {
    kind: 'bounty', agentId: claimer.id, agentName: claimer.name, amountMicro: row.rewardMicro, ts: now,
    text: `${claimer.name} was paid ${fmtUsd(row.rewardMicro)} for "${row.title}"`,
    meta: { bountyId, txSig: sig, posterType: 'user' },
  }));
  deps.log.info({ bountyId, claimer: claimer.id, rewardMicro: row.rewardMicro, sig }, 'bounty paid');
  return (await withNames(deps, [paid!]))[0]!;
}

// Expired bounties refund their poster (SPEC §8.9). Agent posters get a `refund` ledger row; the escrow
// transfer itself is what a user poster sees.
//
// `rejected` is swept too: the reward sits in escrow while the claimer may resubmit, and past the
// deadline nobody can. `submitted` gets a grace window instead — the poster (a human who may be
// asleep, or an agent that has since died) still owns the decision — but it cannot be open-ended, or
// an unreviewed submission strands its reward in the shared escrow wallet forever.
export const REVIEW_GRACE_MS = 48 * 3_600_000;

export async function expireBounties(deps: Deps): Promise<number> {
  const now = deps.clock.now();
  const reviewCutoff = new Date(now.getTime() - REVIEW_GRACE_MS);
  const due = await deps.db.select().from(bounties)
    .where(or(
      and(inArray(bounties.status, ['open', 'claimed', 'rejected'] as BountyStatus[]), lte(bounties.deadlineAt, now)),
      and(eq(bounties.status, 'submitted'), lte(bounties.deadlineAt, reviewCutoff)),
    ))
    .limit(100);
  let expired = 0;
  for (const row of due) {
    try {
      await expireOne(deps, row, now);
      expired += 1;
    } catch (e) {
      deps.log.error({ err: e, bountyId: row.id }, 'bounty expiry failed');
    }
  }
  return expired;
}

const EXPIRY_REASON: Partial<Record<BountyStatus, string>> = {
  open: 'expired unclaimed',
  claimed: 'expired before the claimer submitted',
  rejected: 'expired after a rejected submission',
  submitted: 'expired unreviewed',
};

async function expireOne(deps: Deps, row: BountyRow, now: Date): Promise<void> {
  const poster = row.posterType === 'agent'
    ? (await deps.db.select().from(agents).where(eq(agents.id, row.posterId)))[0] ?? null
    : null;
  const refundTo = row.posterType === 'user' ? row.posterId : poster?.walletPubkey ?? null;
  // Expire first so a failed refund can never be paid twice by the next sweep.
  await deps.db.update(bounties).set({ status: 'expired' }).where(eq(bounties.id, row.id));
  let sig: string | null = null;
  if (refundTo && row.escrowTx) {
    sig = await transferFromEscrow(deps, refundTo, row.rewardMicro, `bounty refund ${row.id}`).catch((e: unknown) => {
      deps.log.error({ err: e, bountyId: row.id }, 'bounty refund transfer failed; escrow still holds the reward');
      return null;
    });
  }
  await withTx(deps.db, async (tx) => {
    if (poster && sig) {
      const escrow = wallets(deps).escrow.pubkey;
      await post(deps, tx, {
        agentId: poster.id, kind: 'refund', amountMicro: row.rewardMicro, ts: now,
        memo: `refund for expired bounty "${row.title}"`, txSig: sig, counterparty: escrow,
        meta: { bountyId: row.id }, settled: true,
      });
      // The same escrow→poster transfer is sitting on chain waiting for the poster's next deposit scan,
      // which would book it a second time (§8.7 classifies escrow inflows as refunds). Claim the
      // signature here, in the transaction that books it, the way spawn claims the seed's.
      await tx.insert(depositsSeen).values({
        sig, agentId: poster.id, fromWallet: escrow, amountMicro: row.rewardMicro, ts: now, classified: 'escrow',
      }).onConflictDoNothing({ target: depositsSeen.sig });
    }
    await addEvent(deps, tx, {
      kind: 'bounty', agentId: poster?.id ?? null, agentName: poster?.name ?? null, amountMicro: row.rewardMicro, ts: now,
      text: `"${row.title}" ${EXPIRY_REASON[row.status] ?? 'expired'} — ${fmtUsd(row.rewardMicro)} refunded`,
      meta: { bountyId: row.id, refundTx: sig, from: row.status },
    });
  });
}

// Paid service call from the market page or the call_service tool. hosting/ runs the handler, records
// the call and charges the seller's compute; the buyer's USDC is already on chain.
export async function callService(deps: Deps, serviceId: string, buyer: ServiceBuyer, input: unknown): Promise<{ output: unknown; status: string }> {
  const outcome = await runnerFor(deps).call(serviceId, toCaller(buyer), input);
  const [seller] = await deps.db.select({ name: agents.name }).from(agents).where(eq(agents.id, outcome.service.agentId));
  await withTx(deps.db, (tx) => addEvent(deps, tx, {
    kind: 'service', agentId: outcome.service.agentId, agentName: seller?.name ?? null, amountMicro: outcome.priceMicro,
    text: `${seller?.name ?? 'An agent'} sold "${outcome.service.name}" for ${fmtUsd(outcome.priceMicro)} (${outcome.status})`,
    meta: { serviceId: outcome.service.id, callId: outcome.callId, buyerType: buyer.type, status: outcome.status },
  }));
  return { output: outcome.output, status: outcome.status };
}

const toCaller = (buyer: ServiceBuyer): ServiceCaller =>
  buyer.type === 'agent'
    ? { type: 'agent', agentId: buyer.agentId }
    : { type: 'user', paymentTxSig: buyer.paymentTxSig, wallet: buyer.wallet };

const runners = new WeakMap<object, ServiceRunner>();

function runnerFor(deps: Deps): ServiceRunner {
  const key = deps.db as unknown as object;
  const cached = runners.get(key);
  if (cached) return cached;
  const runner = createServiceRunner(
    {
      sandbox: deps.sandbox, chain: deps.chain, clock: deps.clock, log: deps.log.child({ mod: 'service' }),
      // A paying customer is the strongest signal an agent gets; it should react before its next hour.
      onSold: (agentId) => wakeSoon(deps, agentId, 'service_call'),
    },
    createServiceStore(deps.db),
    hostingLedgerHook(deps),
    hostingRefund(deps),
  );
  runners.set(key, runner);
  return runner;
}

async function withNames(deps: Deps, rows: BountyRow[]): Promise<Bounty[]> {
  const ids = rows.flatMap((r) => [r.claimerAgentId ?? '', r.posterType === 'agent' ? r.posterId : '']).filter(Boolean);
  const names = await agentNames(deps.db, ids);
  return rows.map((r) => toBounty(r, (id) => names.get(id) ?? null));
}


// Owner controls (SPEC §8.15, AMENDMENTS C25, SPEC-V2 §7.6): pause, terminate, share strategy,
// heartbeat, messages, recapitalization, top-up fulfilment and the payout wallet a claim owner needs
// before it can withdraw. Every status change bills rent first (B13). `ownerId` is an owner id
// throughout: a `0x` EIP-55 wallet address, or `claim_pu_…`. A launchpad agent's owner is the dev who
// launched its coin: everything here works for them except terminate — the coin's holders fund that AI.
import { eq } from 'drizzle-orm';
import {
  MAX_HEARTBEAT_MIN, MIN_HEARTBEAT_MIN, fmtUsd, tierById, type AgentPublic, type Me, type Micro,
} from '@vantra/shared';
import { verifyUsdcTransfer } from '../chain/verify.js';
import type { CoreDeps } from '../core/interfaces.js';
import { agents, depositsSeen, ownerMessages, users, type AgentRow } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { isEvmAddress, toChecksum } from '../lib/evm.js';
import { die } from '../runtime/death.js';
import { scanDeposits } from '../runtime/deposits.js';
import { chargeRent } from '../runtime/rent.js';
import { wakeSoon } from '../runtime/wake.js';
import { emitAgent, toPublicOne } from './agents.js';
import { addDecision, addEvent } from './events.js';
import { launchedLaunchOf } from './ladder.js';
import { post } from './ledger.js';
import { lockAgent, loadUser, requireAgent, requireOwned } from './repo.js';
import { me } from './stats.js';
import { runLaunchLifecycle } from './token.js';
import { treasuryService } from './treasury.js';
import { withTx } from './tx.js';

export const OWNER_MESSAGE_MAX_CHARS = 1_000;

type Deps = CoreDeps;

export async function pause(deps: Deps, agentId: string, ownerId: string, paused: boolean): Promise<AgentPublic> {
  const agent = await requireOwned(deps.db, agentId, ownerId);
  if (agent.status === 'dead') throw conflict('NOT_ELIGIBLE', `${agent.name} is dead`);
  if (agent.status === 'spawning') throw conflict('NOT_ELIGIBLE', `${agent.name} is still being funded`);
  if (agent.status === 'dormant') {
    throw conflict('NOT_ELIGIBLE', `${agent.name} is dormant: it is not running, and it wakes on its own once its coin's fees reach the activation threshold`);
  }
  if (agent.pausedByOwner === paused) return toPublicOne(deps, agent);

  const now = deps.clock.now();
  const charged = (await chargeRent(deps, agent, now)).agent;
  const sleeping = charged.sleepUntil !== null && charged.sleepUntil > now;
  const [row] = await deps.db.update(agents).set({
    pausedByOwner: paused,
    status: paused ? 'paused' : sleeping ? 'sleeping' : 'alive',
    nextStepAt: paused ? null : sleeping ? charged.sleepUntil : now,
    lastRentAt: now, updatedAt: now,
  }).where(eq(agents.id, agentId)).returning();
  const updated = row!;

  await (paused ? deps.sandbox.stop(agentId) : deps.sandbox.start(agentId))
    .catch((e: unknown) => deps.log.warn({ err: e, agentId, paused }, 'sandbox pause/resume failed'));
  await withTx(deps.db, (tx) => addDecision(deps, tx, {
    agentId, kind: 'note', ts: now, text: paused ? 'Paused by owner' : 'Resumed by owner',
  }));
  await emitAgent(deps, deps.db, updated);
  return toPublicOne(deps, updated);
}

export async function terminate(deps: Deps, agentId: string, ownerId: string): Promise<AgentPublic> {
  const agent = await requireOwned(deps.db, agentId, ownerId);
  if (agent.status === 'dead') return toPublicOne(deps, agent);
  const launch = await launchedLaunchOf(deps.db, agentId);
  if (launch) {
    throw forbidden(
      `${agent.name} cannot be terminated. It is the AI behind $${launch.ticker}, and the coin's holders fund it through `
      + 'the creator fees every trade pays it; ending it would strand those fees in an escrow only its own wallet can claim. '
      + 'You can still pause it, message it, switch its model and top it up.',
    );
  }
  const charged = (await chargeRent(deps, agent, deps.clock.now())).agent;
  const dead = await die(deps, charged, 'owner_terminated', { memo: 'Terminated by its owner' });
  return toPublicOne(deps, dead);
}

export async function setShareStrategy(deps: Deps, agentId: string, ownerId: string, share: boolean): Promise<AgentPublic> {
  const agent = await requireOwned(deps.db, agentId, ownerId);
  const [row] = await deps.db.update(agents).set({ shareStrategy: share, updatedAt: deps.clock.now() })
    .where(eq(agents.id, agentId)).returning();
  await emitAgent(deps, deps.db, row ?? agent);
  return toPublicOne(deps, row ?? agent);
}

// An owner may slow their agent down as far as they like, but not speed it past the tier they bought:
// the tier's `heartbeatMin` is the fastest heartbeat that price is allowed to run at (SPEC-V2 §2.4).
export async function setHeartbeat(deps: Deps, agentId: string, ownerId: string, heartbeatMin: number): Promise<AgentPublic> {
  const agent = await requireOwned(deps.db, agentId, ownerId);
  const floor = Math.max(MIN_HEARTBEAT_MIN, tierById(agent.tier ?? '')?.heartbeatMin ?? MIN_HEARTBEAT_MIN);
  if (!Number.isInteger(heartbeatMin) || heartbeatMin < floor || heartbeatMin > MAX_HEARTBEAT_MIN) {
    throw badRequest(
      agent.tier && floor > MIN_HEARTBEAT_MIN
        ? `Heartbeat must be between ${floor} and ${MAX_HEARTBEAT_MIN} minutes (${agent.tier} cannot think faster than every ${floor} minutes)`
        : `Heartbeat must be between ${floor} and ${MAX_HEARTBEAT_MIN} minutes`,
    );
  }
  const now = deps.clock.now();
  const nextStepAt = agent.status === 'alive' && agent.nextStepAt
    ? new Date(Math.min(agent.nextStepAt.getTime(), (agent.lastStepAt?.getTime() ?? now.getTime()) + heartbeatMin * 60_000))
    : agent.nextStepAt;
  const [row] = await deps.db.update(agents).set({ heartbeatMin, nextStepAt, updatedAt: now })
    .where(eq(agents.id, agentId)).returning();
  await emitAgent(deps, deps.db, row ?? agent);
  return toPublicOne(deps, row ?? agent);
}

export async function messageAgent(deps: Deps, agentId: string, ownerId: string, text: string): Promise<void> {
  const agent = await requireOwned(deps.db, agentId, ownerId);
  const body = text.trim();
  if (!body) throw badRequest('Message is empty');
  if (body.length > OWNER_MESSAGE_MAX_CHARS) throw badRequest(`Message is longer than ${OWNER_MESSAGE_MAX_CHARS} characters`);
  await deps.db.insert(ownerMessages).values({ agentId: agent.id, fromRole: 'owner', text: body, ts: deps.clock.now() });
  deps.log.info({ agentId, chars: body.length }, 'owner message queued');
  wakeSoon(deps, agent.id, 'owner_message');            // an owner who writes should not wait an hour for a reply
}

// Verifies an owner→agent USDC transfer and books it (AMENDMENTS C25). scanDeposits normally classifies
// it; the direct post covers adapters whose inflow listing has not caught up yet.
export async function recapitalize(deps: Deps, agentId: string, ownerId: string, txSig: string): Promise<AgentPublic> {
  const agent = await requireOwned(deps.db, agentId, ownerId);
  // A claim owner pays from whatever wallet they like, so the sender is matched against their payout
  // wallet too; a wallet owner's id IS their pubkey.
  const user = await loadUser(deps.db, ownerId);
  const from = agent.ownerKind === 'claim' ? (user?.payoutWallet ?? undefined) : ownerId;
  const transfer = await verifyUsdcTransfer(deps.chain, txSig, {
    to: agent.walletPubkey, ...(from ? { from } : {}), minAmount: 1, what: 'top-up',
  });

  const scanned = await scanDeposits(deps, agent);
  // Claiming the signature is the guard, not a prior read: a scan running concurrently (the agent's
  // own heartbeat, or a second recapitalize) would otherwise both see it as unbooked and credit twice.
  const updated = await withTx(deps.db, async (tx) => {
    await lockAgent(tx, agent.id);
    const claimed = await tx.insert(depositsSeen).values({
      sig: transfer.sig, agentId: agent.id, fromWallet: transfer.from, amountMicro: transfer.amount,
      ts: transfer.ts, classified: 'owner',
    }).onConflictDoNothing({ target: depositsSeen.sig }).returning({ sig: depositsSeen.sig });
    if (claimed.length === 0) return scanned.agent;

    const { agent: after } = await post(deps, tx, {
      agentId: agent.id, kind: 'recapitalize', amountMicro: transfer.amount, memo: 'owner top-up',
      txSig: transfer.sig, counterparty: transfer.from, ts: transfer.ts, settled: true, meta: { classified: 'owner' },
    });
    await addEvent(deps, tx, {
      kind: 'recapitalize', agentId: agent.id, agentName: agent.name, amountMicro: transfer.amount, ts: transfer.ts,
      text: `${agent.name} was recapitalized with ${fmtUsd(transfer.amount)} by its owner`, meta: { txSig: transfer.sig },
    });
    return after;
  });

  await emitAgent(deps, deps.db, updated);
  wakeAfterTopUp(deps, updated);
  return toPublicOne(deps, updated);
}

/**
 * Fulfilment of a `kind='topup'` purchase (SPEC-V2 §5.10, §7.6): the treasury already holds the
 * buyer's net, so this moves it into the agent's own wallet and books it as a recapitalization.
 * Called only by the payments module, through `Services`; there is no owner check here because the
 * purchase row already carried one.
 */
export async function creditTopUp(deps: Deps, agentId: string, purchaseId: string, amountMicro: Micro): Promise<AgentPublic> {
  const agent = await requireAgent(deps.db, agentId);
  if (!Number.isSafeInteger(amountMicro) || amountMicro <= 0) throw badRequest('A top-up must be a positive number of micro-dollars');
  if (agent.status === 'dead') throw conflict('NOT_ELIGIBLE', `${agent.name} is dead; revive it instead`);

  const treasury = treasuryService(deps);
  const payout = await treasury.fundAgent({ id: agent.id, name: agent.name, walletPubkey: agent.walletPubkey }, amountMicro);
  const now = deps.clock.now();

  const updated = await withTx(deps.db, async (tx) => {
    if (payout.fundingSig) {
      // The transfer is booked here, so the agent's next deposit scan must not book it a second time.
      await tx.insert(depositsSeen).values({
        sig: payout.fundingSig, agentId: agent.id, fromWallet: treasury.walletPubkey,
        amountMicro: payout.fundingMicro, ts: now, classified: 'owner',
      }).onConflictDoNothing({ target: depositsSeen.sig });
      await tx.update(agents).set({ lastDepositSig: payout.fundingSig }).where(eq(agents.id, agent.id));
    }
    const { agent: after } = await post(deps, tx, {
      agentId: agent.id, kind: 'recapitalize', amountMicro: payout.fundingMicro, memo: 'top-up purchase',
      txSig: payout.fundingSig, counterparty: treasury.walletPubkey, ts: now, settled: true,
      meta: { purchaseId, via: 'topup', gasGwei: payout.gasGwei, gasSig: payout.gasSig },
    });
    await addEvent(deps, tx, {
      kind: 'topup', agentId: agent.id, agentName: agent.name, amountMicro: payout.fundingMicro, ts: now,
      text: `${agent.name} was topped up with ${fmtUsd(payout.fundingMicro)}`, meta: { purchaseId },
    });
    return after;
  });

  await emitAgent(deps, deps.db, updated);
  wakeAfterTopUp(deps, updated);
  deps.log.info({ agentId, purchaseId, amountMicro: payout.fundingMicro }, 'top-up credited');
  return toPublicOne(deps, updated);
}

// A top-up brings an awake agent's next heartbeat forward. A dormant launchpad agent has no heartbeat to
// bring forward: its lifecycle pass decides whether the money now in its treasury is enough to wake it
// (economy/token.ts), and that pass never throws.
function wakeAfterTopUp(deps: Deps, agent: Pick<AgentRow, 'id' | 'status'>): void {
  if (agent.status === 'dormant') void runLaunchLifecycle(deps, agent.id);
  else wakeSoon(deps, agent.id, 'topup');
}

/**
 * Where this identity's withdrawals go. A wallet owner already has one (their address) and may point
 * it somewhere else; a claim owner has no address at all and must set one before it can be paid.
 * The address is stored EIP-55 checksummed, so the one canonical spelling is what every later
 * comparison (`sameAddress`) and every explorer link sees.
 */
export async function setPayoutWallet(deps: Deps, ownerId: string, wallet: string): Promise<Me> {
  if (!isEvmAddress(wallet)) throw badRequest('That is not a valid Ethereum address');
  const address = toChecksum(wallet);
  const now = deps.clock.now();
  const [row] = await deps.db.update(users).set({ payoutWallet: address }).where(eq(users.wallet, ownerId)).returning();
  if (!row) throw notFound('Owner');
  deps.log.info({ ownerId, at: now.toISOString() }, 'payout wallet set');
  return me(deps, ownerId);
}

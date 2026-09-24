// Owner withdrawals (SPEC §8.11, SPEC-V2 §6.2): age + payback eligibility, a 30-day reserve and a
// 2.5% fee to the TREASURY. v2 pays out to a payout wallet rather than to the owner id: a claim
// identity has no wallet of its own, so it must name one first. A launchpad agent is never withdrawable:
// its money is its coin's creator fees, and letting the dev drain them is exactly what the fee-recipient
// lock exists to prevent (launchpad spec §2) — its surplus is bought back and burned instead.
import { eq } from 'drizzle-orm';
import {
  DAY_MS, RESERVE_DAYS, RESERVE_MIN_MICRO, WITHDRAW_FEE_BPS, WITHDRAW_MIN_AGE_DAYS,
  bpsOf, fmtUsd, type Micro, type Withdrawable,
} from '@vantra/shared';
import type { CoreDeps } from '../core/interfaces.js';
import { agents, withdrawals, type AgentRow } from '../db/schema.js';
import { conflict, forbidden } from '../lib/errors.js';
import { toPublicOne } from './agents.js';
import { addEvent } from './events.js';
import { launchedLaunchOf } from './ladder.js';
import { post } from './ledger.js';
import { treasuryService } from './treasury.js';
import { lockAgent, payoutWalletOf, requireOwned } from './repo.js';
import { withTx } from './tx.js';
import { transferFromAgent, wallets } from './wallets.js';

type Deps = CoreDeps;

const withdrawableStatuses = new Set(['alive', 'sleeping', 'paused']);

export const launchedWithdrawReason = (name: string, ticker: string): string =>
  `Nothing can be withdrawn from ${name}: it lives on the creator fees of $${ticker}, so its holders fund it. `
  + 'Anything above its runway floor is spent buying back and burning the coin instead.';

// Reserve keeps a live agent 30 days of runway (never below one minimum purchase); a dead agent keeps nothing.
function reserveOf(a: Pick<AgentRow, 'status'>, burnPerDayMicro: Micro): Micro {
  if (a.status === 'dead') return 0;
  return Math.max(RESERVE_MIN_MICRO, RESERVE_DAYS * burnPerDayMicro);
}

// SPEC §8.11 eligibility, with the owner-terminate exception (dead by owner → no age rule).
// `launchTicker` is the ticker of the agent's live launchpad coin, or null for every other agent.
export function withdrawableOf(a: AgentRow, burnPerDayMicro: Micro, now: Date, launchTicker: string | null): Withdrawable {
  const reserveMicro = reserveOf(a, burnPerDayMicro);
  if (launchTicker !== null) return { amountMicro: 0, reserveMicro, eligible: false, reason: launchedWithdrawReason(a.name, launchTicker) };
  const amountMicro = Math.max(0, a.treasuryMicro - a.unsettledMicro - reserveMicro);
  const terminated = a.status === 'dead' && a.deathCause === 'owner_terminated';
  const ageDays = (now.getTime() - a.bornAt.getTime()) / DAY_MS;

  const reason = !terminated && !withdrawableStatuses.has(a.status)
    ? `${a.name} is ${a.status}`
    : !terminated && ageDays < WITHDRAW_MIN_AGE_DAYS
      ? `Withdrawals open at ${WITHDRAW_MIN_AGE_DAYS} days old (${ageDays.toFixed(1)}d so far)`
      : a.revenueExternalMicro < a.fundingMicro
        ? `External revenue must cover the ${fmtUsd(a.fundingMicro)} that was paid for this agent first (${fmtUsd(a.revenueExternalMicro)} so far)`
        : amountMicro <= 0
          ? `Nothing withdrawable: ${fmtUsd(a.treasuryMicro)} treasury − ${fmtUsd(a.unsettledMicro)} unsettled − ${fmtUsd(reserveMicro)} reserve`
          : null;

  return { amountMicro: reason ? 0 : amountMicro, reserveMicro, eligible: reason === null, reason };
}

export interface WithdrawResult { sentMicro: Micro; feeMicro: Micro; txSig: string | null }

export async function withdraw(
  deps: Deps, agentId: string, ownerId: string, amountMicro?: Micro, payoutWallet?: string,
): Promise<WithdrawResult> {
  const owned = await requireOwned(deps.db, agentId, ownerId);
  // Refused before anything else — even a missing payout wallet — so the dev is told the real reason.
  const launch = await launchedLaunchOf(deps.db, agentId);
  if (launch) throw forbidden(launchedWithdrawReason(owned.name, launch.ticker));
  const now = deps.clock.now();
  const treasuryWallet = wallets(deps).treasury.pubkey;
  // A wallet owner's id IS their pubkey, so the default is unchanged; a claim owner has no pubkey and
  // must have set `users.payout_wallet` first (SPEC-V2 §6.2).
  const destination = (payoutWallet ?? await payoutWalletOf(deps.db, ownerId))?.trim();
  if (!destination) {
    throw conflict('PAYOUT_WALLET_REQUIRED', 'Set a payout wallet before withdrawing: this identity has no wallet of its own');
  }
  // Burn is a trailing statistic, unaffected by a concurrent withdrawal; treasury and unsettled are
  // not, so the reserve maths below is re-run against the LOCKED row.
  const burnPerDayMicro = (await toPublicOne(deps, owned)).burnPerDayMicro;

  // Written inside the transaction and read from the catch, so the attempt survives the rollback.
  const attempt: { planned?: { gross: Micro; feeMicro: Micro; sentMicro: Micro } } = {};
  let result: { sentMicro: Micro; feeMicro: Micro; txSig: string; feeSig: string | null; treasuryMicro: Micro };
  try {
    // One transaction, lock first, and the lock is held across the transfers: two overlapping
    // withdrawals (a double-clicked button is enough) would otherwise both read the same withdrawable
    // balance, both send, and leave the agent below the reserve SPEC §8.11 exists to protect.
    result = await withTx(deps.db, async (tx) => {
      const locked = await lockAgent(tx, agentId);
      const available = withdrawableOf(locked, burnPerDayMicro, now, null);
      if (!available.eligible) throw conflict('NOT_ELIGIBLE', available.reason ?? 'Not withdrawable');

      const gross = Math.min(amountMicro ?? available.amountMicro, available.amountMicro);
      if (!Number.isSafeInteger(gross) || gross <= 0) throw conflict('NOT_ELIGIBLE', 'Withdraw amount must be a positive number of micro-dollars');
      const feeMicro = bpsOf(gross, WITHDRAW_FEE_BPS);
      const sentMicro = gross - feeMicro;
      if (sentMicro <= 0) throw conflict('NOT_ELIGIBLE', 'Withdraw amount is smaller than the withdrawal fee');
      attempt.planned = { gross, feeMicro, sentMicro };

      const [row] = await tx.insert(withdrawals)
        .values({ agentId, ownerWallet: destination, amountMicro: sentMicro, feeMicro, ts: now, status: 'pending' }).returning();
      // The agent's key is read on this connection so the transfer never waits on a second one.
      const signer = { ...deps, db: tx };
      const txSig = await transferFromAgent(signer, agentId, destination, sentMicro, `VANTRA withdrawal ${agentId}`);
      const feeSig = feeMicro > 0
        ? await transferFromAgent(signer, agentId, treasuryWallet, feeMicro, 'VANTRA withdrawal fee').catch((e: unknown) => {
          deps.log.error({ err: e, agentId, feeMicro }, 'withdrawal fee transfer failed; fee stays with the agent');
          return null;
        })
        : null;

      const after = await post(deps, tx, {
        agentId, kind: 'withdrawal', amountMicro: -sentMicro, memo: `withdrawal to ${destination}`,
        txSig, counterparty: destination, meta: { grossMicro: gross, feeMicro, ownerId },
      });
      const withFee = feeSig === null ? after : await post(deps, tx, {
        agentId, kind: 'withdrawal_fee', amountMicro: -feeMicro, memo: `withdrawal fee ${WITHDRAW_FEE_BPS / 100}%`,
        txSig: feeSig, counterparty: treasuryWallet,
      });
      await tx.update(withdrawals).set({ status: 'sent', txSig }).where(eq(withdrawals.id, row!.id));
      await tx.update(agents).set({ updatedAt: now }).where(eq(agents.id, agentId));
      await addEvent(deps, tx, {
        kind: 'withdraw', agentId, agentName: owned.name, amountMicro: -sentMicro,
        text: `${owned.name} paid ${fmtUsd(sentMicro)} to its owner (fee ${fmtUsd(feeMicro)})`,
        meta: { feeMicro, txSig },
      });
      return { sentMicro, feeMicro, txSig, feeSig, treasuryMicro: withFee.agent.treasuryMicro };
    });
  } catch (e) {
    // The pending row rolled back with the transaction; keep the attempt visible to the owner.
    const planned = attempt.planned;
    if (planned) {
      await deps.db.insert(withdrawals)
        .values({ agentId, ownerWallet: destination, amountMicro: planned.sentMicro, feeMicro: planned.feeMicro, ts: now, status: 'failed' })
        .catch((err: unknown) => deps.log.error({ err, agentId }, 'could not record the failed withdrawal'));
    }
    throw e;
  }

  if (result.feeSig !== null && result.feeMicro > 0) {
    await treasuryService(deps).recordInflow('withdraw_fee', result.feeMicro, result.feeSig, agentId);
  }
  deps.log.info({ agentId, sentMicro: result.sentMicro, feeMicro: result.feeMicro, treasuryMicro: result.treasuryMicro }, 'withdrawal sent');
  return { sentMicro: result.sentMicro, feeMicro: result.feeMicro, txSig: result.txSig };
}

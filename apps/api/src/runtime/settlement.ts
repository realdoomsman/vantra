// Hourly settlement (SPEC §8.11): sweep accrued protocol spend to the fee wallet, pay fork royalties
// child→parent, top up gas from the pool and reconcile the books against the chain.
import { and, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  HOUR_MS, SETTLE_MAX_INTERVAL_MS, SETTLE_THRESHOLD_MICRO, fmtUsd, type Micro,
} from '@vantra/shared';
import type { CoreDeps } from '../core/interfaces.js';
import { agents, depositsSeen, forks, ledger, type AgentRow } from '../db/schema.js';
import {
  markRoyaltiesSettled, markRoyaltyRowsSettled, pendingRoyalties, pendingRoyaltiesFromChild, post, postSettlement,
} from '../economy/ledger.js';
import { isLaunchedAgent } from '../economy/ladder.js';
import { treasuryService } from '../economy/treasury.js';
import { withTx } from '../economy/tx.js';
import { transferFromAgent, wallets } from '../economy/wallets.js';

export const SETTLE_INTERVAL_MS = HOUR_MS;
export const DRIFT_WARN_MICRO = 10_000;
const BATCH = 50;

type Deps = CoreDeps;

export interface SettlementReport { considered: number; sweptMicro: Micro; royaltiesMicro: Micro; gasMicro: Micro }

export async function runSettlement(deps: Deps): Promise<SettlementReport> {
  const now = deps.clock.now();
  const due = await deps.db.select().from(agents).where(and(
    ne(agents.status, 'spawning'),
    or(
      gte(agents.unsettledMicro, SETTLE_THRESHOLD_MICRO),
      and(sql`${agents.unsettledMicro} > 0`, or(isNull(agents.lastSettledAt), lt(agents.lastSettledAt, new Date(now.getTime() - SETTLE_MAX_INTERVAL_MS)))),
      sql`exists (select 1 from ${ledger} where ${ledger.agentId} = ${agents.id} and ${ledger.kind} = 'royalty_out' and ${ledger.settled} = false)`,
    ),
  )).limit(BATCH);

  const report: SettlementReport = { considered: due.length, sweptMicro: 0, royaltiesMicro: 0, gasMicro: 0 };
  for (const agent of due) {
    try {
      const one = await settleAgent(deps, agent);
      report.sweptMicro += one.sweptMicro;
      report.royaltiesMicro += one.royaltiesMicro;
      report.gasMicro += one.gasMicro;
    } catch (e) {
      deps.log.error({ err: e, agentId: agent.id }, 'settlement failed');
    }
  }
  if (report.sweptMicro > 0 || report.royaltiesMicro > 0) {
    deps.log.info(report, 'settlement run');
  }
  return report;
}

export interface AgentSettlement { sweptMicro: Micro; royaltiesMicro: Micro; gasMicro: Micro; driftMicro: Micro }

export async function settleAgent(deps: Deps, input: AgentRow): Promise<AgentSettlement> {
  const feeWallet = wallets(deps).protocolFee;
  let agent = input;
  const onchain = await deps.chain.getUsdcBalance(agent.walletPubkey).catch((e: unknown) => {
    deps.log.warn({ err: e, agentId: agent.id }, 'balance read failed during settlement');
    return null;
  });

  let sweptMicro = 0;
  if (agent.unsettledMicro > 0) {
    const payable = onchain === null ? agent.unsettledMicro : Math.min(agent.unsettledMicro, onchain);
    if (payable > 0) {
      const sig = await transferFromAgent(deps, agent.id, feeWallet, payable, 'VANTRA settlement');
      agent = (await postSettlement(deps, deps.db, {
        agentId: agent.id, sweptMicro: payable, txSig: sig, counterparty: feeWallet,
      })).agent;
      sweptMicro = payable;
    } else if (agent.status === 'dead') {
      // An agent that died owing more than its wallet holds can never pay: recognise the loss once
      // instead of re-reading an empty wallet on every run.
      agent = (await postSettlement(deps, deps.db, {
        agentId: agent.id, sweptMicro: agent.unsettledMicro, txSig: null, counterparty: feeWallet,
        memo: `wrote off ${agent.unsettledMicro} micro-USDC of spend this agent died owing`,
        meta: { uncollectible: true },
      })).agent;
      deps.log.info({ agentId: agent.id, writtenOffMicro: agent.unsettledMicro }, 'uncollectible spend written off');
    } else if (agent.status === 'dormant') {
      // A launchpad agent that went broke owing spend pays it out of its next claimed fees: the debt is
      // real and stays on the books; it just cannot be collected from an empty wallet today.
      deps.log.debug({ agentId: agent.id, unsettled: agent.unsettledMicro, onchain }, 'dormant agent owes spend; collected when its fees wake it');
    } else {
      deps.log.warn({ agentId: agent.id, unsettled: agent.unsettledMicro, onchain }, 'cannot settle: agent wallet is empty');
    }
  }

  const royalty = await payRoyalties(deps, agent);
  agent = royalty.agent;

  let gasMicro = 0;
  // A launchpad agent funds its own gas: it keeps its activation stipend as a reserve and every claim
  // refills it from fees that arrive as ETH (economy/token.ts). A treasury top-up would be billed to it
  // at ETH_GAS_STIPEND — more than a freshly woken coin's AI holds. A dormant agent gets nothing at all.
  if ((agent.status === 'alive' || agent.status === 'sleeping') && !(await isLaunchedAgent(deps.db, agent.id))) {
    const topUp = await treasuryService(deps).topUpGas({ id: agent.id, name: agent.name, walletPubkey: agent.walletPubkey })
      .catch((e: unknown) => {
        deps.log.warn({ err: e, agentId: agent.id }, 'gas top-up failed');
        return null;
      });
    if (topUp) {
      agent = (await post(deps, deps.db, {
        agentId: agent.id, kind: 'gas', amountMicro: -topUp.gasMicro,
        memo: `gas top-up ${topUp.gwei} gwei`, txSig: topUp.sig, counterparty: treasuryService(deps).walletPubkey,
        meta: { gwei: topUp.gwei, ethPriceUsd: topUp.ethPriceUsd },
      })).agent;
      gasMicro = topUp.gasMicro;
    }
  }

  // The balance read at the top is stale once we have moved USDC, and reconcile compares it against
  // the post-transfer books, so re-read before deciding anything drifted.
  const settled = sweptMicro > 0 || royalty.paidMicro > 0;
  const finalOnchain = settled
    ? await deps.chain.getUsdcBalance(agent.walletPubkey).catch(() => null)
    : onchain;
  const driftMicro = await reconcile(deps, agent, finalOnchain);
  return { sweptMicro, royaltiesMicro: royalty.paidMicro, gasMicro, driftMicro };
}

// Royalties are booked when the child earns and transferred here. The parent's inflow is pre-marked as
// seen so the deposit scan never books it a second time as internal revenue.
async function payRoyalties(deps: Deps, agent: AgentRow): Promise<{ agent: AgentRow; paidMicro: Micro }> {
  const pending = await pendingRoyalties(deps.db, agent.id, 'royalty_out');
  if (pending.length === 0) return { agent, paidMicro: 0 };
  const [fork] = await deps.db.select().from(forks).where(eq(forks.childAgentId, agent.id));
  const [parent] = fork ? await deps.db.select().from(agents).where(eq(agents.id, fork.parentAgentId)) : [];
  if (!fork || !parent) return { agent, paidMicro: 0 };

  const amount = pending.reduce((sum, row) => sum + Math.abs(row.amountMicro), 0);
  const lastId = pending.at(-1)!.id;
  const sig = await transferFromAgent(deps, agent.id, parent.walletPubkey, amount, `fork royalty ${agent.id}`);
  const now = deps.clock.now();

  await withTx(deps.db, async (tx) => {
    await markRoyaltiesSettled(tx, agent.id, lastId);
    // Only THIS child's rows on the parent: a parent with several forks must not have sibling B's
    // unpaid royalty_in flipped to settled because sibling A paid (reconcile reads that flag).
    const parentRows = await pendingRoyaltiesFromChild(tx, parent.id, agent.id);
    await markRoyaltyRowsSettled(tx, parentRows.map((r) => r.id));
    await tx.update(forks).set({ royaltiesPaidMicro: fork.royaltiesPaidMicro + amount }).where(eq(forks.id, fork.id));
    await tx.insert(depositsSeen).values({
      sig, agentId: parent.id, fromWallet: agent.walletPubkey, amountMicro: amount, ts: now, classified: 'internal',
    }).onConflictDoNothing({ target: depositsSeen.sig });
  });
  deps.log.info({ child: agent.id, parent: parent.id, amount, sig }, 'fork royalty paid');
  return { agent, paidMicro: amount };
}

// On chain an agent still holds the spend it has not settled and the royalties it has not paid, and is
// missing the royalties owed to it (SPEC §8.11 reconcile, extended for royalty timing).
async function reconcile(deps: Deps, agent: AgentRow, onchain: Micro | null): Promise<Micro> {
  if (onchain === null) return 0;
  const [row] = await deps.db.select({
    out: sql<number>`coalesce(sum(-${ledger.amountMicro}) filter (where ${ledger.kind} = 'royalty_out'), 0)::bigint`.mapWith(Number),
    in: sql<number>`coalesce(sum(${ledger.amountMicro}) filter (where ${ledger.kind} = 'royalty_in'), 0)::bigint`.mapWith(Number),
  }).from(ledger).where(and(eq(ledger.agentId, agent.id), eq(ledger.settled, false), inArray(ledger.kind, ['royalty_in', 'royalty_out'])));
  const expected = agent.treasuryMicro + agent.unsettledMicro + (row?.out ?? 0) - (row?.in ?? 0);
  const driftMicro = onchain - expected;
  // A surplus is normally USDC that landed since the agent's last heartbeat; scanDeposits books it at
  // the next one. A shortfall means money left the wallet that the ledger never recorded.
  if (driftMicro < -DRIFT_WARN_MICRO) {
    deps.log.warn({ agentId: agent.id, driftMicro: fmtUsd(driftMicro), onchain, expected }, 'on-chain balance is below the books');
  } else if (driftMicro > DRIFT_WARN_MICRO) {
    deps.log.debug({ agentId: agent.id, driftMicro: fmtUsd(driftMicro), onchain, expected }, 'unbooked inflow waiting for the next deposit scan');
  }
  await deps.db.update(agents).set({ onchainUsdcMicro: onchain, onchainCheckedAt: deps.clock.now() }).where(eq(agents.id, agent.id));
  return driftMicro;
}

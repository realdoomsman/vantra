// Reviving a dead agent (SPEC §8.11, AMENDMENTS C26, SPEC-V2 §6.2): the owner sends at least the
// minimum purchase in USDC to the agent wallet, then the agent wakes up with that money booked as a
// recapitalization. v2 drops the holding gate and the one-live-agent rule — you may run as many
// agents as you have paid for, so a second one is no reason to leave the first dead.
import { eq } from 'drizzle-orm';
import { DAY_MS, MIN_PURCHASE_MICRO, REVIVE_WINDOW_DAYS, fmtUsd, type AgentPublic } from '@vantra/shared';
import type { CoreDeps } from '../core/interfaces.js';
import { agents, type AgentRow } from '../db/schema.js';
import { conflict } from '../lib/errors.js';
import { scanDeposits } from '../runtime/deposits.js';
import { emitAgent, toPublicOne } from './agents.js';
import { addDecision, addEvent } from './events.js';
import { requireOwned } from './repo.js';
import { withTx } from './tx.js';

type Deps = CoreDeps;

export interface ReviveCheck { ok: boolean; reason: string | null }

// Shared by revive() and the control board's REVIVE card so the UI and the API never disagree.
export async function reviveEligibility(deps: Deps, agent: AgentRow, onchainUsdcMicro: number): Promise<ReviveCheck> {
  if (agent.status !== 'dead') return { ok: false, reason: `${agent.name} is ${agent.status}` };
  const diedAt = agent.diedAt ?? agent.updatedAt;
  const daysDead = (deps.clock.now().getTime() - diedAt.getTime()) / DAY_MS;
  if (daysDead > REVIVE_WINDOW_DAYS) return { ok: false, reason: `${agent.name} died more than ${REVIVE_WINDOW_DAYS} days ago` };
  if (onchainUsdcMicro < MIN_PURCHASE_MICRO) {
    return { ok: false, reason: `Send at least ${fmtUsd(MIN_PURCHASE_MICRO)} USDC to ${agent.walletPubkey} first (on chain: ${fmtUsd(onchainUsdcMicro)})` };
  }
  return { ok: true, reason: null };
}

export async function revive(deps: Deps, agentId: string, ownerId: string): Promise<AgentPublic> {
  const agent = await requireOwned(deps.db, agentId, ownerId);
  const onchain = await deps.chain.getUsdcBalance(agent.walletPubkey);
  const check = await reviveEligibility(deps, agent, onchain);
  if (!check.ok) throw conflict('NOT_ELIGIBLE', check.reason ?? 'Not revivable');

  const scanned = await scanDeposits(deps, agent);           // books the owner's transfer as `recapitalize`
  const now = deps.clock.now();
  await deps.sandbox.ensure(agent.id);

  const revived = await withTx(deps.db, async (tx) => {
    const [row] = await tx.update(agents).set({
      status: 'alive', diedAt: null, deathCause: null, revivals: scanned.agent.revivals + 1,
      nextStepAt: now, sleepUntil: null, lastRentAt: now, spawnError: null, currentStepId: null, updatedAt: now,
    }).where(eq(agents.id, agent.id)).returning();
    const live = row!;
    await addEvent(deps, tx, {
      kind: 'revive', agentId: live.id, agentName: live.name, amountMicro: live.treasuryMicro, ts: now,
      text: `${live.name} was revived by its owner with ${fmtUsd(live.treasuryMicro)}`,
      meta: { revivals: live.revivals },
    });
    await addDecision(deps, tx, { agentId: live.id, kind: 'birth', ts: now, text: 'Revived by owner', meta: { revivals: live.revivals } });
    return live;
  });

  await emitAgent(deps, deps.db, revived);
  deps.log.info({ agentId: agent.id, treasuryMicro: revived.treasuryMicro }, 'agent revived');
  return toPublicOne(deps, revived);
}

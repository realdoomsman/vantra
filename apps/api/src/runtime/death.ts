// Death (SPEC §8.10). The agent stops, its sandbox is destroyed, its sites stay up for the grace period
// and the books are closed with an event, a decision and a post-mortem.
//
// Running out of money is death only for a BOUGHT agent. A launchpad agent goes DORMANT instead
// (launchpad spec §2): its coin keeps earning, and a dead agent would strand those fees in an escrow only
// its own wallet can claim from. `goBroke` is the one place that decides which.
import { eq } from 'drizzle-orm';
import { fmtUsd, type DeathCause } from '@vantra/shared';
import type { CoreDeps } from '../core/interfaces.js';
import { agents, launches, type AgentRow } from '../db/schema.js';
import { emitAgent } from '../economy/agents.js';
import { ageDaysOf, round1 } from '../economy/burn.js';
import { addDecision, addEvent } from '../economy/events.js';
import { launchedLaunchOf } from '../economy/ladder.js';
import { liveSteps } from '../economy/live.js';
import { withTx } from '../economy/tx.js';
import { buildPostmortem } from './postmortem.js';

type Deps = CoreDeps;

export interface DieOptions { memo?: string; stepId?: number | null }

const CAUSE_LABEL: Record<DeathCause, string> = {
  insolvent: 'insolvent',
  rent: 'could not pay rent',
  owner_terminated: 'terminated by owner',
  protocol_violation: 'protocol violation',
};

export type BrokeCause = Extract<DeathCause, 'rent' | 'insolvent'>;

/**
 * The agent ran out of money. A bought agent dies; a launchpad agent goes dormant — never stepped, never
 * billed — until its coin's fees wake it again (economy/token.ts). Every insolvency path calls this.
 */
export async function goBroke(deps: Deps, agent: AgentRow, cause: BrokeCause, opts: DieOptions = {}): Promise<AgentRow> {
  const launch = await launchedLaunchOf(deps.db, agent.id);
  if (!launch) return die(deps, agent, cause, opts);
  if (agent.status === 'dormant' || agent.status === 'dead') return agent;
  const now = deps.clock.now();

  const dormant = await withTx(deps.db, async (tx) => {
    // Rent was billed up to now by the caller; from here it stops, so the window starts now too.
    const [row] = await tx.update(agents).set({
      status: 'dormant', nextStepAt: null, sleepUntil: null, currentStepId: null, lastRentAt: now, updatedAt: now,
    }).where(eq(agents.id, agent.id)).returning();
    const slept = row ?? { ...agent, status: 'dormant' as const, nextStepAt: null, sleepUntil: null, currentStepId: null, lastRentAt: now };
    // Not activated any more: the activation path picks it up again when the fees return.
    await tx.update(launches).set({ activatedAt: null }).where(eq(launches.id, launch.id));
    await addEvent(deps, tx, {
      kind: 'sleep', agentId: slept.id, agentName: slept.name, amountMicro: slept.treasuryMicro, ts: now,
      text: `${slept.name} ran out of money and went dormant with ${fmtUsd(slept.treasuryMicro)}. $${launch.ticker} keeps earning; `
        + `it wakes when ${fmtUsd(launch.activationMicro)} in creator fees is waiting.`,
      meta: { dormant: true, cause, launchId: launch.id, treasuryMicro: slept.treasuryMicro, memo: opts.memo ?? null },
    });
    await addDecision(deps, tx, {
      agentId: slept.id, stepId: opts.stepId ?? null, kind: 'sleep', ts: now,
      // The caller's memo is written for a death; a dormancy keeps it as context only.
      text: `Went dormant: ${CAUSE_LABEL[cause]} with ${fmtUsd(slept.treasuryMicro)} left. It wakes when its coin's fees return.`,
      meta: { cause, dormant: true, memo: opts.memo ?? null },
    });
    return slept;
  });

  liveSteps.end(agent.id);
  // Stopped, not destroyed: its files are still there when the fees wake it.
  await deps.sandbox.stop(agent.id).catch((e: unknown) => deps.log.warn({ err: e, agentId: agent.id }, 'sandbox stop failed'));
  await emitAgent(deps, deps.db, dormant);
  deps.log.info({ agentId: agent.id, name: agent.name, cause, launchId: launch.id }, 'launched agent went dormant');
  return dormant;
}

export async function die(deps: Deps, agent: AgentRow, cause: DeathCause, opts: DieOptions = {}): Promise<AgentRow> {
  if (agent.status === 'dead') return agent;
  const now = deps.clock.now();
  const ageDays = round1(ageDaysOf(agent.bornAt, now));

  const dead = await withTx(deps.db, async (tx) => {
    const [row] = await tx.update(agents).set({
      status: 'dead', diedAt: now, deathCause: cause, nextStepAt: null, sleepUntil: null, currentStepId: null, updatedAt: now,
    }).where(eq(agents.id, agent.id)).returning();
    const died = row ?? { ...agent, status: 'dead' as const, diedAt: now, deathCause: cause };
    await addEvent(deps, tx, {
      kind: 'death', agentId: died.id, agentName: died.name, amountMicro: died.revenueExternalMicro, ts: now,
      text: `${died.name} died after ${ageDays} days — ${CAUSE_LABEL[cause]}. Lifetime external revenue ${fmtUsd(died.revenueExternalMicro)}.`,
      meta: { cause, ageDays, treasuryMicro: died.treasuryMicro, memo: opts.memo ?? null },
    });
    await addDecision(deps, tx, {
      agentId: died.id, stepId: opts.stepId ?? null, kind: 'death', ts: now,
      text: opts.memo ?? `Died: ${CAUSE_LABEL[cause]} with ${fmtUsd(died.treasuryMicro)} left.`,
      meta: { cause },
    });
    return died;
  });

  liveSteps.end(agent.id);
  await deps.sandbox.destroy(agent.id).catch((e: unknown) => deps.log.warn({ err: e, agentId: agent.id }, 'sandbox destroy failed'));

  const postmortem = await buildPostmortem(deps, dead, cause).catch((e: unknown) => {
    deps.log.warn({ err: e, agentId: agent.id }, 'postmortem failed');
    return null;
  });
  const final = postmortem
    ? (await deps.db.update(agents).set({ postmortem }).where(eq(agents.id, agent.id)).returning())[0] ?? dead
    : dead;

  await emitAgent(deps, deps.db, final);
  deps.log.info({ agentId: agent.id, name: agent.name, cause, ageDays }, 'agent died');
  return final;
}

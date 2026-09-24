// Event-driven wakes (SPEC-V2 §7.4). Between heartbeats the world keeps moving: a customer pays for a
// service, a human posts a bounty, an owner sends a message or tops the treasury up. Waiting for the
// next scheduled heartbeat wastes hours of a paid lifespan, so these bring the next step forward —
// never closer than MIN_WAKE_GAP_MIN, and never for an agent that is paused, dead, dormant or mid-step.
// A dormant launchpad agent has no money to think with; only its coin's fees wake it (economy/token.ts).
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { BOUNTY_WAKE_MIN_SAVING_MIN, MIN_WAKE_GAP_MIN, WAKE_FANOUT_MAX } from '@vantra/shared';
import type { CoreDeps } from '../core/interfaces.js';
import { agents, bounties, type AgentRow } from '../db/schema.js';
import { emitAgent } from '../economy/agents.js';
import { addDecision, addEvent } from '../economy/events.js';
import { withTx } from '../economy/tx.js';

export type WakeReason = 'service_call' | 'bounty' | 'owner_message' | 'topup' | 'deposit';

const REASON_TEXT: Record<WakeReason, string> = {
  service_call: 'someone paid for one of its services',
  bounty: 'a new bounty was posted',
  owner_message: 'its owner sent a message',
  topup: 'money arrived from its owner',
  deposit: 'money arrived in its wallet',
};

/**
 * Brings an agent's next heartbeat forward. Returns true when the schedule actually moved.
 * Fire-and-forget at every call site: a failed wake must never fail the action that triggered it.
 */
export async function wakeAgent(deps: CoreDeps, agentId: string, reason: WakeReason): Promise<boolean> {
  const [row] = await deps.db.select().from(agents).where(eq(agents.id, agentId));
  if (!row) return false;
  switch (row.status) {
    case 'alive': case 'sleeping': break;
    case 'dormant': case 'paused': case 'spawning': case 'dead': return false;
  }
  if (row.pausedByOwner || row.currentStepId !== null) return false;

  const now = deps.clock.now();
  // A wake must not become a way to spend an agent's treasury faster than it chose to: the earliest a
  // woken step may run is MIN_WAKE_GAP_MIN after the last one finished.
  const floor = (row.lastStepAt ?? now).getTime() + MIN_WAKE_GAP_MIN * 60_000;
  const earliest = new Date(Math.max(now.getTime(), floor));
  if (row.nextStepAt !== null && row.nextStepAt.getTime() <= earliest.getTime()) return false;

  // `status` deliberately stays 'sleeping': runStep wakes a sleeper whose sleepUntil has passed and
  // charges the sleep rent for the interval on the way through (runtime/step.ts).
  const [updated] = await deps.db.update(agents)
    .set({
      nextStepAt: earliest,
      ...(row.status === 'sleeping' ? { sleepUntil: earliest } : {}),
      updatedAt: now,
    })
    .where(eq(agents.id, agentId)).returning();
  const agent: AgentRow = updated ?? row;

  if (row.status === 'sleeping') {
    await withTx(deps.db, async (tx) => {
      await addEvent(deps, tx, {
        kind: 'wake', agentId: agent.id, agentName: agent.name, ts: now,
        text: `${agent.name} woke early: ${REASON_TEXT[reason]}`, meta: { reason },
      });
      await addDecision(deps, tx, { agentId: agent.id, kind: 'note', ts: now, text: `Woken early by ${reason}`, meta: { reason } });
    });
  }
  await emitAgent(deps, deps.db, agent);
  deps.log.debug({ agentId, reason, nextStepAt: earliest.toISOString() }, 'agent woken');
  return true;
}

/**
 * A new bounty is only worth money to an agent that can see it before it is claimed. Wakes the richest
 * agents that hold `list_bounties` and were not about to run anyway. Returns how many actually moved.
 */
export async function wakeForBounty(deps: CoreDeps, bountyId: string): Promise<number> {
  const now = deps.clock.now();
  const soon = new Date(now.getTime() + BOUNTY_WAKE_MIN_SAVING_MIN * 60_000);
  const rows = await deps.db.select({ id: agents.id }).from(agents).where(and(
    inArray(agents.status, ['alive', 'sleeping']),          // a dormant agent cannot afford to look
    eq(agents.pausedByOwner, false),
    isNull(agents.currentStepId),
    sql`${agents.enabledTools} @> '["list_bounties"]'::jsonb`,
    or(isNull(agents.nextStepAt), gt(agents.nextStepAt, soon)),
    notThePoster(bountyId),
  )).orderBy(desc(agents.treasuryMicro)).limit(WAKE_FANOUT_MAX);

  let woken = 0;
  for (const row of rows) {
    if (await wakeAgent(deps, row.id, 'bounty')) woken += 1;
  }
  if (woken > 0) deps.log.info({ bountyId, woken }, 'woke agents for a new bounty');
  return woken;
}

// An agent that posted the bounty itself has nothing to wake up for.
const notThePoster = (bountyId: string) => sql`not exists (
  select 1 from ${bounties}
  where ${bounties.id} = ${bountyId} and ${bounties.posterType} = 'agent' and ${bounties.posterId} = ${agents.id}
)`;

// Fire-and-forget wrappers. Every call site in §7.4 uses one of these so a wake can never turn a
// successful action (a paid service call, a posted bounty, a top-up) into a 500.
export function wakeSoon(deps: CoreDeps, agentId: string, reason: WakeReason): void {
  void wakeAgent(deps, agentId, reason).catch((e: unknown) => deps.log.warn({ err: e, agentId, reason }, 'wake failed'));
}

export function wakeBountyFanout(deps: CoreDeps, bountyId: string): void {
  void wakeForBounty(deps, bountyId).catch((e: unknown) => deps.log.warn({ err: e, bountyId }, 'bounty wake fanout failed'));
}

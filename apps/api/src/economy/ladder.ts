// The launch ladder (launchpad spec §3): what a launched agent's cumulative creator fees have unlocked,
// which of those models it can afford right now, and the dev's model switch under both gates. Also the
// one query every other module uses to ask "is this agent a launchpad coin's AI?" — a question that
// decides whether it may die, be withdrawn from, or be terminated.
import { and, eq } from 'drizzle-orm';
import {
  LAUNCH_LADDER, burnPerDayAt, fmtUsd, runwayDaysAt, sameAddress, tierById, unlockedRung,
  type LadderRung, type LadderStep, type LadderView, type Micro, type TierId, type ToolName,
} from '@vantra/shared';
import type { CoreDeps } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import { agents, launches, type AgentRow, type LaunchRow } from '../db/schema.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { emitAgent } from './agents.js';
import { addDecision, addEvent } from './events.js';
import { withTx } from './tx.js';

// Mock models join the ladder only when the router serves nothing else (LLM_PROVIDER=mock), so the
// demo has a cheap model at the bottom and a strong one at PRIME to switch between.
const MOCK_RUNG_MODELS: Partial<Record<LadderRung, string>> = { SPARK: 'mock-fast', PRIME: 'mock-strong' };

// The model is the dev's call, never the agent's own: a launched agent that could `set_model` itself
// would walk straight past the fee gate the ladder exists to enforce.
const DEV_ONLY_TOOLS: Partial<Record<ToolName, true>> = { set_model: true };

/** A launched agent's tools at a tier: the tier's own, minus the dev-only model switch. */
export function launchToolsFor(tierId: TierId): ToolName[] {
  const tier = tierById(tierId);
  if (!tier) throw badRequest(`Unknown tier ${tierId}`);
  return tier.enabledTools.filter((t) => !DEV_ONLY_TOOLS[t]);
}

/** The launch row of an agent whose coin is live, or null for every other agent (bought, or still unsigned). */
export async function launchedLaunchOf(db: DbLike, agentId: string): Promise<LaunchRow | null> {
  const [row] = await db.select().from(launches)
    .where(and(eq(launches.agentId, agentId), eq(launches.state, 'launched'))).limit(1);
  return row ?? null;
}

export const isLaunchedAgent = async (db: DbLike, agentId: string): Promise<boolean> =>
  (await launchedLaunchOf(db, agentId)) !== null;

/** The rung's models the router actually serves, in ladder order; plus the mock model in mock mode. */
export function availableModels(deps: Pick<CoreDeps, 'llm'>, step: LadderStep): string[] {
  const offered = new Set(deps.llm.models().map((m) => m.id));
  const ids = step.models.filter((id) => offered.has(id));
  const mock = deps.llm.mode === 'mock' ? MOCK_RUNG_MODELS[step.rung] : undefined;
  if (mock && offered.has(mock) && !ids.includes(mock)) ids.push(mock);
  return ids;
}

const rungIndex = (step: LadderStep | null): number => (step ? LAUNCH_LADDER.indexOf(step) : -1);

/** Projected days of life on `modelId` at the agent's current treasury and heartbeat; null when the router does not serve it. */
function runwayOn(deps: Pick<CoreDeps, 'llm'>, agent: AgentRow, modelId: string): number | null {
  const pricing = deps.llm.models().find((m) => m.id === modelId);
  return pricing ? runwayDaysAt(agent.heartbeatMin, Math.max(0, agent.treasuryMicro), pricing) : null;
}

const affordable = (deps: Pick<CoreDeps, 'llm' | 'config'>, agent: AgentRow, modelId: string): boolean =>
  (runwayOn(deps, agent, modelId) ?? 0) >= deps.config.launch.modelSwitchMinRunwayDays;

/**
 * A day of life on the most expensive model its dev could switch it to right now (unlocked by fees and
 * served by the router), at its current heartbeat; 0 while nothing is unlocked. The burn floor keeps
 * `modelSwitchMinRunwayDays` of this, so the burn can never price an unlocked model out of the switch
 * gate above — both use the same burnPerDayAt projection.
 */
export function priciestUnlockedBurnPerDay(deps: Pick<CoreDeps, 'llm'>, agent: AgentRow): Micro {
  const served = deps.llm.models();
  let priciest = 0;
  for (const step of LAUNCH_LADDER) {
    if (agent.creatorRewardMicro < step.unlockMicro) continue;
    for (const id of availableModels(deps, step)) {
      const pricing = served.find((m) => m.id === id);
      if (pricing) priciest = Math.max(priciest, burnPerDayAt(agent.heartbeatMin, pricing));
    }
  }
  return priciest;
}

// A rung is affordable only when EVERY model it offers is: the switcher then never shows a button the
// server would refuse. Unlock is by cumulative fees claimed (agents.creator_reward_micro).
export async function ladderView(deps: CoreDeps, agent: AgentRow): Promise<LadderView[]> {
  return LAUNCH_LADDER.map((step) => {
    const models = availableModels(deps, step);
    return {
      ...step,
      models: [...step.models],
      unlocked: agent.creatorRewardMicro >= step.unlockMicro,
      affordable: models.length > 0 && models.every((id) => affordable(deps, agent, id)),
      availableModels: models,
    };
  });
}

// The dev switches its AI's model. Gate 1: the model's rung is unlocked by fees claimed. Gate 2: the
// treasury would still last `modelSwitchMinRunwayDays` on it. Only the wallet that launched the coin.
export async function setLaunchModel(deps: CoreDeps, launchId: string, devWallet: string, model: string): Promise<void> {
  const [launch] = await deps.db.select().from(launches).where(eq(launches.id, launchId)).limit(1);
  if (!launch) throw notFound('Launch');
  if (!sameAddress(launch.devWallet, devWallet)) throw forbidden("Only the dev who launched this coin can switch its AI's model.");
  if (launch.state !== 'launched') {
    throw badRequest(`$${launch.ticker} is ${launch.state.replace('_', ' ')}; its AI has no model to switch until the coin is live.`);
  }
  const [agent] = await deps.db.select().from(agents).where(eq(agents.id, launch.agentId)).limit(1);
  if (!agent) throw notFound('Agent');
  if (agent.status === 'dead') throw badRequest(`${agent.name} is dead; there is no model to switch.`);

  const wanted = model.trim();
  if (wanted === agent.model) return;
  const ladder = await ladderView(deps, agent);
  const rung = ladder.find((r) => r.availableModels.includes(wanted));
  if (!rung) {
    const listed = LAUNCH_LADDER.some((s) => s.models.includes(wanted));
    throw badRequest(
      listed ? `${wanted} is on the ladder but this deployment does not serve it.` : `${wanted} is not a model on the launch ladder.`,
      'UNKNOWN_MODEL',
    );
  }
  if (!rung.unlocked) {
    throw forbidden(
      `${wanted} unlocks at ${rung.rung}: ${fmtUsd(rung.unlockMicro)} in cumulative creator fees. `
      + `$${launch.ticker} has earned ${fmtUsd(agent.creatorRewardMicro)} so far.`,
    );
  }
  const days = runwayOn(deps, agent, wanted) ?? 0;
  const minDays = deps.config.launch.modelSwitchMinRunwayDays;
  if (days < minDays) {
    throw badRequest(
      `${agent.name} cannot afford ${wanted} yet: with ${fmtUsd(agent.treasuryMicro)} it would last ${days} days on it `
      + `at a ${agent.heartbeatMin}-minute heartbeat, and a switch needs at least ${minDays} days of runway.`,
    );
  }

  const now = deps.clock.now();
  const updated = await withTx(deps.db, async (tx) => {
    const [row] = await tx.update(agents).set({ model: wanted, updatedAt: now }).where(eq(agents.id, agent.id)).returning();
    await addDecision(deps, tx, {
      agentId: agent.id, kind: 'pivot', ts: now,
      text: `Its dev switched the model ${agent.model} → ${wanted} (${rung.rung} rung, ${days} days of runway on it)`,
      meta: { from: agent.model, to: wanted, rung: rung.rung, by: 'dev', launchId },
    });
    return row ?? { ...agent, model: wanted };
  });
  await emitAgent(deps, deps.db, updated);
  deps.log.info({ agentId: agent.id, launchId, from: agent.model, to: wanted, rung: rung.rung }, 'launch model switched by its dev');
}

/**
 * Applies a rung's tier to a launched agent: its tools (minus the dev-only model switch) and the fastest
 * heartbeat that tier allows. Never touches the model. The dev-only heartbeat override still wins, as it
 * does for every new agent.
 */
export async function applyTier(deps: CoreDeps, agent: AgentRow, tierId: TierId): Promise<AgentRow> {
  const tier = tierById(tierId);
  if (!tier) throw badRequest(`Unknown tier ${tierId}`);
  const enabledTools = launchToolsFor(tierId);
  const heartbeatMin = deps.config.economy.heartbeatOverrideMin ?? tier.heartbeatMin;
  const now = deps.clock.now();
  // A faster heartbeat should not wait out the slower one it replaces.
  const nextStepAt = agent.status === 'alive' && agent.nextStepAt
    ? new Date(Math.min(agent.nextStepAt.getTime(), (agent.lastStepAt ?? now).getTime() + heartbeatMin * 60_000))
    : agent.nextStepAt;
  const [row] = await deps.db.update(agents)
    .set({ tier: tierId, enabledTools, heartbeatMin, nextStepAt, updatedAt: now })
    .where(eq(agents.id, agent.id)).returning();
  return row ?? { ...agent, tier: tierId, enabledTools, heartbeatMin, nextStepAt };
}

/**
 * After a claim: if cumulative fees crossed one or more rungs since `beforeMicro`, apply the highest
 * rung's tier and post a milestone for each rung crossed. Returns the agent, updated or not.
 */
export async function climbLadder(deps: CoreDeps, agent: AgentRow, launch: LaunchRow, beforeMicro: number): Promise<AgentRow> {
  const before = unlockedRung(beforeMicro);
  const after = unlockedRung(agent.creatorRewardMicro);
  if (!after || rungIndex(after) <= rungIndex(before)) return agent;

  const climbed = await applyTier(deps, agent, after.tierId);
  const now = deps.clock.now();
  await withTx(deps.db, async (tx) => {
    for (const step of LAUNCH_LADDER.slice(rungIndex(before) + 1, rungIndex(after) + 1)) {
      const models = availableModels(deps, step);
      await addEvent(deps, tx, {
        kind: 'milestone', agentId: agent.id, agentName: agent.name, ts: now, amountMicro: agent.creatorRewardMicro,
        text: `${agent.name} unlocked ${step.rung}: $${launch.ticker} has earned ${fmtUsd(agent.creatorRewardMicro)} in creator fees`
          + (models.length > 0 ? ` — its dev can now switch it to ${models.join(', ')}` : ''),
        meta: { rung: step.rung, tierId: step.tierId, unlockMicro: step.unlockMicro, launchId: launch.id, models },
      });
    }
  });
  await emitAgent(deps, deps.db, climbed);
  deps.log.info({ agentId: agent.id, from: before?.rung ?? null, to: after.rung, tier: after.tierId }, 'launched agent climbed the ladder');
  return climbed;
}

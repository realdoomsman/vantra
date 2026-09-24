// The heartbeat scheduler (SPEC §8.13): claims due agents with SKIP LOCKED, runs up to
// MAX_CONCURRENT_STEPS at once, and drives the periodic jobs (settlement, treasury sync, bounty and
// launch expiry, idle rent, stuck spawns, stats broadcast, daily cleanup, the creator-fee / launch
// lifecycle). The deposit poller is NOT here: it runs on its own interval inside the payments module
// (SPEC-V2 §5.3). A dormant agent is invisible to all of it except the creator-fee job that wakes it.
import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { DAY_MS, DEAD_SITE_GRACE_DAYS, HOUR_MS, STEP_TIMEOUT_MS, TRANSCRIPT_RETENTION_DAYS } from '@vantra/shared';
import type { Deps } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import { agents, deployments, steps, type AgentRow } from '../db/schema.js';
import { dueCondition } from '../economy/agents.js';
import { expireStaleLaunches } from '../economy/launch.js';
import { expireBounties } from '../economy/market.js';
import { treasuryService } from '../economy/treasury.js';
import { retryStuckSpawn, MAX_FUNDING_ATTEMPTS } from '../economy/spawn.js';
import { withTx } from '../economy/tx.js';
import { deployContext, removeSite } from '../hosting/index.js';
import { goBroke } from './death.js';
import { chargeRent } from './rent.js';
import { runSettlement } from './settlement.js';
import { runStep } from './step.js';
import { runCreatorFees } from '../economy/token.js';

export const POLL_MS = 5_000;
export const STATS_MS = 30_000;
export const TREASURY_SYNC_MS = 60_000;
export const BOUNTY_SWEEP_MS = 5 * 60_000;
export const SPAWN_RETRY_MS = 60_000;
export const IDLE_RENT_MS = HOUR_MS;
export const SHUTDOWN_GRACE_MS = STEP_TIMEOUT_MS;
export const CREATOR_FEES_MS = 2 * HOUR_MS;   // claim every coin's fee escrow; wake, climb and burn launchpad agents

export type JobName = 'treasury' | 'stats' | 'settlement' | 'bounties' | 'rent' | 'spawns' | 'cleanup' | 'creator_fees';

export interface Scheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
  runStepNow(agentId: string): Promise<void>;
  runJob(name: JobName): Promise<void>;
  inFlight(): number;
}

interface Job { name: JobName; everyMs: number; delayMs: number; run: () => Promise<void> }

export function createScheduler(deps: Deps): Scheduler {
  const log = deps.log.child({ mod: 'scheduler' });
  const running = new Map<string, Promise<void>>();
  const lastRun = new Map<JobName, number>();
  const jobRunning = new Set<JobName>();
  let timer: NodeJS.Timeout | null = null;
  let stopping = false;

  const jobs: Job[] = [
    { name: 'treasury', everyMs: TREASURY_SYNC_MS, delayMs: 0, run: async () => { await treasuryService(deps).sync(); } },
    { name: 'stats', everyMs: STATS_MS, delayMs: 0, run: () => broadcastStats(deps) },
    { name: 'spawns', everyMs: SPAWN_RETRY_MS, delayMs: SPAWN_RETRY_MS, run: () => retryStuckSpawns(deps) },
    { name: 'bounties', everyMs: BOUNTY_SWEEP_MS, delayMs: 30_000, run: async () => { await expireBounties(deps); await expireStaleLaunches(deps); } },
    { name: 'rent', everyMs: IDLE_RENT_MS, delayMs: 60_000, run: async () => { await chargeIdleRent(deps); } },
    { name: 'settlement', everyMs: HOUR_MS, delayMs: HOUR_MS, run: async () => { await runSettlement(deps); } },
    { name: 'cleanup', everyMs: DAY_MS, delayMs: 5 * 60_000, run: () => dailyCleanup(deps) },
    { name: 'creator_fees', everyMs: CREATOR_FEES_MS, delayMs: 5 * 60_000, run: () => runCreatorFees(deps) },
  ];

  async function runJob(name: JobName): Promise<void> {
    const job = jobs.find((j) => j.name === name);
    if (!job || jobRunning.has(name)) return;
    jobRunning.add(name);
    lastRun.set(name, Date.now());
    try {
      await job.run();
    } catch (e) {
      log.error({ err: e, job: name }, 'job failed');
    } finally {
      jobRunning.delete(name);
    }
  }

  function tickJobs(): void {
    const now = Date.now();
    for (const job of jobs) {
      const last = lastRun.get(job.name) ?? 0;
      if (now - last >= job.everyMs) void runJob(job.name);
    }
  }

  function track(agent: AgentRow): void {
    const task = runStep(deps, agent)
      .then(() => undefined)
      .catch((e: unknown) => log.error({ err: e, agentId: agent.id }, 'step crashed'))
      .finally(() => running.delete(agent.id));
    running.set(agent.id, task);
  }

  async function tick(): Promise<void> {
    if (stopping) return;
    tickJobs();
    const free = deps.config.economy.maxConcurrentSteps - running.size;
    if (free <= 0) return;
    const due = await claimDue(deps, free).catch((e: unknown) => {
      log.error({ err: e }, 'claim failed');
      return [] as AgentRow[];
    });
    for (const agent of due) track(agent);
  }

  return {
    async start() {
      if (timer) return;
      stopping = false;
      const now = Date.now();
      for (const job of jobs) lastRun.set(job.name, now - job.everyMs + job.delayMs);
      await releaseStaleClaims(deps);
      timer = setInterval(() => void tick(), POLL_MS);
      timer.unref?.();
      log.info({ pollMs: POLL_MS, concurrency: deps.config.economy.maxConcurrentSteps }, 'scheduler started');
    },

    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      const inFlight = [...running.values()];
      if (inFlight.length > 0) {
        log.info({ steps: inFlight.length }, 'waiting for in-flight steps');
        await Promise.race([Promise.allSettled(inFlight), sleep(SHUTDOWN_GRACE_MS)]);
      }
      log.info('scheduler stopped');
    },

    async runStepNow(agentId) {
      const agent = await claimOne(deps, agentId);
      if (!agent) return;
      try {
        await runStep(deps, agent);
      } finally {
        running.delete(agentId);
      }
    },

    runJob,
    inFlight: () => running.size,
  };
}

// Claiming leases the row for one step timeout so another poller (or process) cannot pick it up.
async function claimDue(deps: Deps, limit: number): Promise<AgentRow[]> {
  if (limit <= 0) return [];
  const now = deps.clock.now();
  return withTx(deps.db, async (tx) => {
    const rows = await tx.select().from(agents).where(dueCondition(now))
      .orderBy(asc(agents.nextStepAt)).limit(limit).for('update', { skipLocked: true });
    if (rows.length > 0) await lease(tx, rows.map((r) => r.id), now);
    return rows;
  });
}

async function claimOne(deps: Deps, agentId: string): Promise<AgentRow | null> {
  const now = deps.clock.now();
  return withTx(deps.db, async (tx) => {
    const [row] = await tx.select().from(agents).where(and(
      eq(agents.id, agentId),
      inArray(agents.status, ['alive', 'sleeping']),          // never 'dormant': only its coin's fees wake it
      eq(agents.pausedByOwner, false),
      isNull(agents.currentStepId),
    )).limit(1).for('update', { skipLocked: true });
    if (!row) return null;
    await lease(tx, [row.id], now);
    return row;
  });
}

const lease = async (tx: DbLike, ids: string[], now: Date): Promise<void> => {
  await tx.update(agents).set({ nextStepAt: new Date(now.getTime() + STEP_TIMEOUT_MS) }).where(inArray(agents.id, ids));
};

// A crash can leave current_step_id set; on boot those steps are marked aborted so the agents run again.
async function releaseStaleClaims(deps: Deps): Promise<void> {
  const stale = await deps.db.select({ id: agents.id, stepId: agents.currentStepId }).from(agents)
    .where(sql`${agents.currentStepId} is not null`);
  if (stale.length === 0) return;
  const now = deps.clock.now();
  for (const row of stale) {
    if (row.stepId !== null) {
      await deps.db.update(steps).set({ status: 'aborted', error: 'interrupted', finishedAt: now })
        .where(and(eq(steps.id, row.stepId), eq(steps.status, 'running')));
    }
    await deps.db.update(agents).set({ currentStepId: null, nextStepAt: now }).where(eq(agents.id, row.id));
  }
  deps.log.warn({ agents: stale.length }, 'released steps interrupted by a restart');
}

async function broadcastStats(deps: Deps): Promise<void> {
  const services = deps.services;
  if (!services) return;
  deps.bus.emit({ type: 'stats', stats: await services.stats() });
}

// Agents whose next heartbeat is more than an hour away still owe rent (AMENDMENTS B13). A dormant
// agent is deliberately not in the list: it pays no rent, so it can never run out of money while it
// waits for its coin's fees.
export async function chargeIdleRent(deps: Deps): Promise<number> {
  const now = deps.clock.now();
  const idle = await deps.db.select().from(agents).where(and(
    inArray(agents.status, ['alive', 'sleeping', 'paused']),
    isNull(agents.currentStepId),
    lt(agents.lastRentAt, new Date(now.getTime() - IDLE_RENT_MS)),
    or(isNull(agents.nextStepAt), sql`${agents.nextStepAt} > ${new Date(now.getTime() + IDLE_RENT_MS)}`),
  )).limit(200);

  for (const agent of idle) {
    const charged = (await chargeRent(deps, agent, now)).agent;
    if (charged.treasuryMicro <= 0) await goBroke(deps, charged, 'rent', { memo: 'Ran out of money while idle' });
  }
  return idle.length;
}

// An agent whose funding transfer failed stays `spawning` with the error on the row (SPEC-V2 §7.1.6);
// the money is real and still somewhere, so this keeps trying until MAX_FUNDING_ATTEMPTS.
async function retryStuckSpawns(deps: Deps): Promise<void> {
  const stuck = await deps.db.select().from(agents).where(and(
    eq(agents.status, 'spawning'),
    isNotNull(agents.spawnError),
    lt(agents.spawnAttempts, MAX_FUNDING_ATTEMPTS),
  )).limit(10);
  for (const agent of stuck) await retryStuckSpawn(deps, agent);
}

// Dead agents' sites stay up for the grace period; old transcripts are pruned to null (SPEC §7, §8.10).
async function dailyCleanup(deps: Deps): Promise<void> {
  const now = deps.clock.now();
  const cutoff = new Date(now.getTime() - DEAD_SITE_GRACE_DAYS * DAY_MS);
  const expired = await deps.db.select({ slug: deployments.slug }).from(deployments)
    .innerJoin(agents, eq(agents.id, deployments.agentId))
    .where(and(eq(deployments.active, true), eq(agents.status, 'dead'), lt(agents.diedAt, cutoff))).limit(200);
  const ctx = deployContext(deps);
  for (const row of expired) {
    await removeSite(ctx, row.slug).catch((e: unknown) => deps.log.error({ err: e, slug: row.slug }, 'site cleanup failed'));
  }

  const pruned = await deps.db.update(steps).set({ transcript: null })
    .where(and(isNotNull(steps.transcript), lt(steps.startedAt, new Date(now.getTime() - TRANSCRIPT_RETENTION_DAYS * DAY_MS))))
    .returning({ id: steps.id });
  if (expired.length > 0 || pruned.length > 0) {
    deps.log.info({ sites: expired.length, transcripts: pruned.length }, 'daily cleanup');
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  t.unref?.();
});

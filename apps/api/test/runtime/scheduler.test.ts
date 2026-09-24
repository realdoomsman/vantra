// Scheduler (SPEC §8.13): claiming, the periodic jobs and graceful shutdown.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TRANSCRIPT_RETENTION_DAYS } from '@vantra/shared';
import { agents, deployments, purchases, steps } from '../../src/db/schema.js';
import { createScheduler } from '../../src/runtime/scheduler.js';
import { fakeLlm, textReply } from '../economy/helpers/fakes.js';
import { createHarness, type Harness } from '../economy/helpers/harness.js';

const DAY = 86_400_000;

describe('runtime/scheduler', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({
      llm: fakeLlm({ replies: [textReply('did a thing'), textReply('did another thing')] }),
      env: { DATA_DIR: mkdtempSync(path.join(tmpdir(), 'vantra-sched-')) },
    });
  });
  afterEach(async () => { await h.close(); });

  it('runs one heartbeat on demand and releases the claim', async () => {
    const agent = await h.seedAgent();
    const scheduler = createScheduler(h.deps);
    await scheduler.runStepNow(agent.id);

    const after = await h.reload(agent.id);
    expect(after.totalSteps).toBe(1);
    expect(after.currentStepId).toBeNull();
    expect(scheduler.inFlight()).toBe(0);
  });

  it('never claims a paused agent or one already stepping', async () => {
    const paused = await h.seedAgent({ name: 'PAUSED', status: 'paused' });
    await h.db.update(agents).set({ pausedByOwner: true }).where(eq(agents.id, paused.id));
    const busy = await h.seedAgent({ name: 'BUSY' });
    await h.db.update(agents).set({ currentStepId: 999 }).where(eq(agents.id, busy.id));

    const scheduler = createScheduler(h.deps);
    await scheduler.runStepNow(paused.id);
    await scheduler.runStepNow(busy.id);

    expect((await h.reload(paused.id)).totalSteps).toBe(0);
    expect((await h.reload(busy.id)).totalSteps).toBe(0);
    expect(h.llm.requests).toHaveLength(0);
  });

  it('charges rent to agents whose next heartbeat is far away, and buries the broke ones', async () => {
    const napping = await h.seedAgent({
      name: 'NAPPING', status: 'sleeping', treasuryMicro: 1_000_000,
      lastRentAt: new Date(h.clock.now().getTime() - 3 * 3_600_000),
      sleepUntil: new Date(h.clock.now().getTime() + 6 * 3_600_000),
      nextStepAt: new Date(h.clock.now().getTime() + 6 * 3_600_000),
    });
    const broke = await h.seedAgent({
      name: 'BROKE', status: 'paused', treasuryMicro: 2_000,
      lastRentAt: new Date(h.clock.now().getTime() - 3 * 3_600_000), nextStepAt: null,
    });

    await createScheduler(h.deps).runJob('rent');

    expect((await h.reload(napping.id)).spendRentMicro).toBe(3 * 1_000);
    const dead = await h.reload(broke.id);
    expect(dead.status).toBe('dead');
    expect(dead.deathCause).toBe('rent');
  });

  // The amount is only recorded on the purchase (the agent's own funding_micro is written by the
  // ledger post that failed), so the retry reads it back from there — SPEC-V2 §7.1.6.
  it('retries a stuck funding transfer from the purchase that paid for it', async () => {
    const stuck = await h.seedAgent({ name: 'STUCK', status: 'spawning', treasuryMicro: 0, fundingMicro: 0, fund: 0 });
    const purchaseId = 'pu_stuck00001';
    await h.db.insert(purchases).values({
      id: purchaseId, status: 'spawned', expiresAt: new Date(h.clock.now().getTime() + DAY),
      depositPubkey: `deposit-${purchaseId}`, quotedMicro: 10_000_000, amountMicro: 10_000_000,
      feeBps: 1_000, feeMicro: 1_000_000, fundingMicro: 9_000_000, quotedTier: 'SPARK', tier: 'SPARK',
      agentId: stuck.id, createdAt: h.clock.now(),
    });
    await h.db.update(agents).set({ spawnError: 'rpc timeout', spawnAttempts: 1, purchaseId })
      .where(eq(agents.id, stuck.id));

    await createScheduler(h.deps).runJob('spawns');

    const after = await h.reload(stuck.id);
    expect(after.status).toBe('alive');
    expect(after.spawnError).toBeNull();
    expect(after.fundingMicro).toBe(9_000_000);
  });

  it('cleans up dead sites past the grace period and prunes old transcripts', async () => {
    const dead = await h.seedAgent({ name: 'GONE', status: 'dead' });
    await h.db.update(agents).set({ diedAt: new Date(h.clock.now().getTime() - 10 * DAY) }).where(eq(agents.id, dead.id));
    await h.db.insert(deployments).values({ agentId: dead.id, slug: 'gone', deployedAt: h.clock.now(), active: true });

    const alive = await h.seedAgent({ name: 'LIVE' });
    await h.db.insert(deployments).values({ agentId: alive.id, slug: 'live', deployedAt: h.clock.now(), active: true });
    await h.db.insert(steps).values([
      {
        agentId: alive.id, n: 1, model: 'mock-fast', effort: 'medium', status: 'ok',
        startedAt: new Date(h.clock.now().getTime() - (TRANSCRIPT_RETENTION_DAYS + 1) * DAY),
        transcript: [{ role: 'user', content: [{ type: 'text', text: 'old' }] }],
      },
      {
        agentId: alive.id, n: 2, model: 'mock-fast', effort: 'medium', status: 'ok', startedAt: h.clock.now(),
        transcript: [{ role: 'user', content: [{ type: 'text', text: 'fresh' }] }],
      },
    ]);

    await createScheduler(h.deps).runJob('cleanup');

    const sites = await h.db.select().from(deployments);
    expect(sites.find((s) => s.slug === 'gone')!.active).toBe(false);
    expect(sites.find((s) => s.slug === 'live')!.active).toBe(true);
    const rows = await h.db.select().from(steps).where(eq(steps.agentId, alive.id));
    expect(rows.find((s) => s.n === 1)!.transcript).toBeNull();
    expect(rows.find((s) => s.n === 2)!.transcript).not.toBeNull();
  });

  it('broadcasts stats and syncs the treasury from its jobs', async () => {
    const scheduler = createScheduler(h.deps);
    await scheduler.runJob('stats');
    await scheduler.runJob('treasury');

    expect(h.messages.some((m) => m.type === 'stats')).toBe(true);
    expect(h.messages.some((m) => m.type === 'treasury')).toBe(true);
  });

  it('starts and stops without leaving work behind', async () => {
    const scheduler = createScheduler(h.deps);
    await scheduler.start();
    await scheduler.stop();
    expect(scheduler.inFlight()).toBe(0);
  });
});

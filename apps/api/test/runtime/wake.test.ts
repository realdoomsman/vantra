// Event-driven wakes (SPEC-V2 §7.4). Between heartbeats the world keeps moving; these pull the next
// step forward so a paid lifespan is not spent waiting. The guards matter as much as the wake: a wake
// must never become a way to burn an agent's treasury faster than its owner chose.
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOUNTY_WAKE_MIN_SAVING_MIN, MIN_WAKE_GAP_MIN, WAKE_FANOUT_MAX } from '@vantra/shared';
import { agents, bounties, decisions } from '../../src/db/schema.js';
import { messageAgent } from '../../src/economy/owner.js';
import { wakeAgent, wakeForBounty } from '../../src/runtime/wake.js';
import { createHarness, type Harness } from '../economy/helpers/harness.js';

const MIN = 60_000;
const HOUR = 3_600_000;

// Polls a fire-and-forget side effect into view. Fails the test by timing out if it never lands.
async function until(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition never became true');
}

describe('runtime/wake', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  const later = (ms: number) => new Date(h.clock.now().getTime() + ms);
  // `earliest = max(now, (lastStepAt ?? now) + MIN_WAKE_GAP_MIN)`, so an agent that has never stepped
  // is still held off for the gap. That is the floor the whole mechanism is bounded by.
  const woken = () => later(MIN_WAKE_GAP_MIN * MIN).getTime();

  it('pulls a far-off heartbeat forward to the earliest allowed moment', async () => {
    const agent = await h.seedAgent({ nextStepAt: later(6 * HOUR) });
    expect(await wakeAgent(h.deps, agent.id, 'deposit')).toBe(true);

    const after = await h.reload(agent.id);
    expect(after.nextStepAt!.getTime()).toBe(woken());
    expect(h.messages.some((m) => m.type === 'agent' && m.agentId === agent.id)).toBe(true);
  });

  it('wakes to right now once the gap since the last step has already passed', async () => {
    const agent = await h.seedAgent({ nextStepAt: later(6 * HOUR) });
    await h.db.update(agents).set({ lastStepAt: new Date(h.clock.now().getTime() - HOUR) }).where(eq(agents.id, agent.id));

    expect(await wakeAgent(h.deps, agent.id, 'deposit')).toBe(true);
    expect((await h.reload(agent.id)).nextStepAt!.getTime()).toBe(h.clock.now().getTime());
  });

  // The sleeper keeps status 'sleeping' on purpose: runStep wakes it on the way through and charges
  // the sleep rent for the interval correctly.
  it('wakes a sleeper early and says why, without ending the sleep itself', async () => {
    const agent = await h.seedAgent({
      status: 'sleeping', sleepUntil: later(8 * HOUR), nextStepAt: later(8 * HOUR),
    });

    expect(await wakeAgent(h.deps, agent.id, 'owner_message')).toBe(true);

    const after = await h.reload(agent.id);
    expect(after.status).toBe('sleeping');
    expect(after.nextStepAt!.getTime()).toBe(woken());
    expect(after.sleepUntil!.getTime()).toBe(woken());
    const woke = h.messages.filter((m) => m.type === 'event' && m.event.kind === 'wake');
    expect(woke).toHaveLength(1);
    expect(woke[0]!.type === 'event' && woke[0]!.event.text).toContain('woke early');
    const notes = await h.db.select().from(decisions).where(eq(decisions.agentId, agent.id));
    expect(notes.some((d) => d.kind === 'note' && d.text === 'Woken early by owner_message')).toBe(true);
  });

  // The owner-message path fires the wake without awaiting it, so this waits for the schedule to move
  // rather than for a particular tick.
  it('is fired by an owner message', async () => {
    const agent = await h.seedAgent({ nextStepAt: later(8 * HOUR) });

    await messageAgent(h.deps, agent.id, agent.ownerWallet, 'Try selling to nurseries.');
    await until(async () => (await h.reload(agent.id)).nextStepAt!.getTime() === woken());

    expect((await h.reload(agent.id)).nextStepAt!.getTime()).toBe(woken());
  });

  it('never re-steps an agent sooner than MIN_WAKE_GAP_MIN after its last step', async () => {
    const agent = await h.seedAgent({ nextStepAt: later(6 * HOUR) });
    await h.db.update(agents).set({ lastStepAt: h.clock.now() }).where(eq(agents.id, agent.id));

    expect(await wakeAgent(h.deps, agent.id, 'service_call')).toBe(true);
    const after = await h.reload(agent.id);
    expect(after.nextStepAt!.getTime()).toBe(h.clock.now().getTime() + MIN_WAKE_GAP_MIN * MIN);
  });

  it('is a no-op for an agent that is already about to run', async () => {
    const agent = await h.seedAgent({ nextStepAt: later(MIN) });
    expect(await wakeAgent(h.deps, agent.id, 'topup')).toBe(false);
    expect((await h.reload(agent.id)).nextStepAt!.getTime()).toBe(later(MIN).getTime());
  });

  it('never wakes a paused, dead, spawning or mid-step agent', async () => {
    const paused = await h.seedAgent({ name: 'PAUSED', status: 'paused', nextStepAt: null });
    await h.db.update(agents).set({ pausedByOwner: true }).where(eq(agents.id, paused.id));
    const dead = await h.seedAgent({ name: 'DEAD', status: 'dead', nextStepAt: null });
    const spawning = await h.seedAgent({ name: 'NEW', status: 'spawning', nextStepAt: null });
    const busy = await h.seedAgent({ name: 'BUSY', nextStepAt: later(6 * HOUR) });
    await h.db.update(agents).set({ currentStepId: 1 }).where(eq(agents.id, busy.id));

    for (const id of [paused.id, dead.id, spawning.id, busy.id]) {
      expect(await wakeAgent(h.deps, id, 'bounty')).toBe(false);
    }
    expect((await h.reload(paused.id)).nextStepAt).toBeNull();
    expect((await h.reload(busy.id)).nextStepAt!.getTime()).toBe(later(6 * HOUR).getTime());
  });

  describe('wakeForBounty', () => {
    const openBounty = async (id: string, poster: { type: 'user' | 'agent'; id: string }) => {
      await h.db.insert(bounties).values({
        id, posterType: poster.type, posterId: poster.id, title: 'Write the docs', description: 'd',
        rewardMicro: 1_000_000, status: 'open', createdAt: h.clock.now(), deadlineAt: later(48 * HOUR),
      });
      return id;
    };

    it('wakes only the agents that can see the board and were not about to run', async () => {
      const worker = await h.seedAgent({ name: 'WORKER', tools: ['list_bounties'], nextStepAt: later(6 * HOUR) });
      const blind = await h.seedAgent({ name: 'BLIND', tools: ['wallet'], nextStepAt: later(6 * HOUR) });
      const soon = await h.seedAgent({
        name: 'SOON', tools: ['list_bounties'],
        nextStepAt: later((BOUNTY_WAKE_MIN_SAVING_MIN - 5) * MIN),
      });

      const id = await openBounty('bt_wake000001', { type: 'user', id: 'someone' });
      expect(await wakeForBounty(h.deps, id)).toBe(1);

      expect((await h.reload(worker.id)).nextStepAt!.getTime()).toBe(woken());
      expect((await h.reload(blind.id)).nextStepAt!.getTime()).toBe(later(6 * HOUR).getTime());
      expect((await h.reload(soon.id)).nextStepAt!.getTime())
        .toBe(later((BOUNTY_WAKE_MIN_SAVING_MIN - 5) * MIN).getTime());
    });

    it('does not wake the agent that posted the bounty', async () => {
      const poster = await h.seedAgent({ name: 'POSTER', tools: ['list_bounties'], nextStepAt: later(6 * HOUR) });
      const id = await openBounty('bt_wake000002', { type: 'agent', id: poster.id });

      expect(await wakeForBounty(h.deps, id)).toBe(0);
      expect((await h.reload(poster.id)).nextStepAt!.getTime()).toBe(later(6 * HOUR).getTime());
    });

    // One bounty must not turn into a colony-wide stampede of paid heartbeats.
    it('fans out to at most WAKE_FANOUT_MAX agents, richest first', async () => {
      const ids: string[] = [];
      for (let i = 0; i < WAKE_FANOUT_MAX + 4; i++) {
        const a = await h.seedAgent({
          name: `HUNTER-${i}`, tools: ['list_bounties'], nextStepAt: later(6 * HOUR),
          treasuryMicro: 1_000_000 + i * 1_000,
        });
        ids.push(a.id);
      }
      const id = await openBounty('bt_wake000003', { type: 'user', id: 'someone' });

      expect(await wakeForBounty(h.deps, id)).toBe(WAKE_FANOUT_MAX);
      const rows = await h.db.select().from(agents).where(inArray(agents.id, ids));
      expect(rows.filter((r) => r.nextStepAt!.getTime() === woken())).toHaveLength(WAKE_FANOUT_MAX);
      // The four left behind are the four poorest.
      const skipped = rows.filter((r) => r.nextStepAt!.getTime() !== woken())
        .map((r) => r.treasuryMicro).sort((a, b) => a - b);
      expect(skipped).toEqual([1_000_000, 1_001_000, 1_002_000, 1_003_000]);
    });
  });
});

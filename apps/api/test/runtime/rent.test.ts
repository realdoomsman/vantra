// Rent and hosting proration (SPEC §8.5, AMENDMENTS B13): the window is billed at the rate of the
// status held over it and only moves when the charge was actually posted.
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RENT_SLEEP_PER_HOUR_MICRO } from '@vantra/shared';
import { deployments, ledger } from '../../src/db/schema.js';
import { chargeRent, fixedCostPerHeartbeat, hostingForMs, ratesOf, rentForMs } from '../../src/runtime/rent.js';
import { createHarness, type Harness } from '../economy/helpers/harness.js';

const HOUR = 3_600_000;

describe('runtime/rent', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  it('bills an awake agent at the awake rate', async () => {
    const agent = await h.seedAgent({ status: 'alive' });
    h.clock.advanceHours(2);
    const { agent: after, rentMicro } = await chargeRent(h.deps, agent, h.clock.now());
    expect(rentMicro).toBe(10_000);                       // v2: $0.005/h awake, not $0.02
    expect(after.treasuryMicro).toBe(10_000_000 - 10_000);
    expect(after.spendRentMicro).toBe(10_000);
    expect(after.unsettledMicro).toBe(10_000);
    expect(after.lastRentAt.getTime()).toBe(h.clock.now().getTime());
  });

  it('bills sleeping and paused agents at the sleep rate', async () => {
    const sleeper = await h.seedAgent({ status: 'sleeping' });
    const paused = await h.seedAgent({ status: 'paused' });
    h.clock.advanceHours(5);
    const now = h.clock.now();
    expect((await chargeRent(h.deps, sleeper, now)).rentMicro).toBe(5 * RENT_SLEEP_PER_HOUR_MICRO);
    expect((await chargeRent(h.deps, paused, now)).rentMicro).toBe(5 * RENT_SLEEP_PER_HOUR_MICRO);
  });

  it('prorates a partial hour', async () => {
    const agent = await h.seedAgent();
    h.clock.advance(90 * 60_000);
    const { rentMicro } = await chargeRent(h.deps, agent, h.clock.now());
    expect(rentMicro).toBe(7_500);
  });

  it('adds hosting per active site, prorated over the same window', async () => {
    const agent = await h.seedAgent();
    await h.db.insert(deployments).values([
      { agentId: agent.id, slug: 'one', deployedAt: h.clock.now(), active: true },
      { agentId: agent.id, slug: 'two', deployedAt: h.clock.now(), active: true },
      { agentId: agent.id, slug: 'gone', deployedAt: h.clock.now(), active: false },
    ]);
    h.clock.advanceHours(12);
    const { hostingMicro, sites, agent: after } = await chargeRent(h.deps, agent, h.clock.now());
    expect(sites).toBe(2);
    expect(hostingMicro).toBe(10_000);            // 2 sites × $0.01/day × 0.5 day
    expect(after.spendHostingMicro).toBe(10_000);
    const rows = await h.db.select().from(ledger).where(eq(ledger.agentId, agent.id)).orderBy(asc(ledger.id));
    expect(rows.map((r) => r.kind)).toEqual(['rent', 'hosting']);
    expect(rows.at(-1)!.balanceAfterMicro).toBe(after.treasuryMicro);
  });

  it('charges nothing twice for the same window', async () => {
    const agent = await h.seedAgent();
    h.clock.advanceHours(1);
    const first = await chargeRent(h.deps, agent, h.clock.now());
    const second = await chargeRent(h.deps, first.agent, h.clock.now());
    expect(first.rentMicro).toBe(5_000);
    expect(second.rentMicro).toBe(0);
    expect(second.agent.treasuryMicro).toBe(first.agent.treasuryMicro);
  });

  it('holds the window open when the interval is too short to bill a micro-dollar', async () => {
    const agent = await h.seedAgent();
    h.clock.advance(50);                           // 50ms of rent rounds to zero
    const { rentMicro, agent: after } = await chargeRent(h.deps, agent, h.clock.now());
    expect(rentMicro).toBe(0);
    expect(after.lastRentAt.getTime()).toBe(agent.lastRentAt.getTime());
  });

  it('moves the window without charging a dead agent', async () => {
    const agent = await h.seedAgent({ status: 'dead' });
    h.clock.advanceHours(3);
    const { rentMicro, agent: after } = await chargeRent(h.deps, agent, h.clock.now());
    expect(rentMicro).toBe(0);
    expect(after.lastRentAt.getTime()).toBe(h.clock.now().getTime());
    expect(after.treasuryMicro).toBe(agent.treasuryMicro);
  });

  it('computes one heartbeat of fixed cost for minStep', () => {
    const rates = ratesOf(h.deps);
    const agent = { status: 'alive' as const, heartbeatMin: 15 };
    expect(fixedCostPerHeartbeat(agent, 1, rates)).toBe(rentForMs('alive', 15 * 60_000, rates) + hostingForMs(1, 15 * 60_000, rates));
    expect(fixedCostPerHeartbeat(agent, 0, rates)).toBe(1_250);        // 15 min at $0.005/h
  });
});

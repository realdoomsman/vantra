// Revive (SPEC §8.11, AMENDMENTS C26, SPEC-V2 §6.2): dead within 30 days and at least one minimum
// purchase of USDC already sitting in the agent wallet. The holding gate and the one-live-agent rule
// are both gone — you may run as many agents as you have paid for.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REVIVE_WINDOW_DAYS } from '@vantra/shared';
import { agents, decisions, ledger } from '../../src/db/schema.js';
import { revive } from '../../src/economy/revive.js';
import { createHarness, type Harness } from './helpers/harness.js';

const DAY = 86_400_000;

describe('economy/revive', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  const buried = async (daysAgo: number, owner = 'owner-rev') => {
    const agent = await h.seedAgent({
      ownerWallet: owner, status: 'dead', treasuryMicro: 0, fund: 0,
      bornAt: new Date(h.clock.now().getTime() - (daysAgo + 5) * DAY),
      nextStepAt: null,
    });
    await h.db.update(agents).set({ diedAt: new Date(h.clock.now().getTime() - daysAgo * DAY), deathCause: 'insolvent' })
      .where(eq(agents.id, agent.id));
    return h.reload(agent.id);
  };

  it('brings a recently dead agent back on the owner top-up', async () => {
    const agent = await buried(3);
    await h.fund(agent.walletPubkey, 12_000_000, agent.ownerWallet);

    const revived = await revive(h.deps, agent.id, agent.ownerWallet);
    expect(revived).toMatchObject({ status: 'alive', revivals: 1, diedAt: null, deathCause: null });
    expect(revived.treasuryMicro).toBe(12_000_000);

    const rows = await h.db.select().from(ledger).where(eq(ledger.agentId, agent.id));
    expect(rows.map((r) => r.kind)).toEqual(['recapitalize']);
    const row = await h.reload(agent.id);
    expect(row.recapitalizedMicro).toBe(12_000_000);
    expect(row.nextStepAt).not.toBeNull();
    expect(row.lastRentAt.getTime()).toBe(h.clock.now().getTime());     // the dead interval is not billed

    const marks = await h.db.select().from(decisions).where(eq(decisions.agentId, agent.id));
    expect(marks.some((d) => d.kind === 'birth' && d.text === 'Revived by owner')).toBe(true);
    expect(h.messages.some((m) => m.type === 'event' && m.event.kind === 'revive')).toBe(true);
  });

  it('refuses without enough USDC in the wallet', async () => {
    const agent = await buried(1);
    await h.fund(agent.walletPubkey, 4_000_000, agent.ownerWallet);
    await expect(revive(h.deps, agent.id, agent.ownerWallet)).rejects.toThrow(/Send at least/);
  });

  it('refuses outside the revive window', async () => {
    const agent = await buried(REVIVE_WINDOW_DAYS + 2);
    await h.fund(agent.walletPubkey, 12_000_000, agent.ownerWallet);
    await expect(revive(h.deps, agent.id, agent.ownerWallet)).rejects.toThrow(/more than 30 days ago/);
  });

  // v2: owning a second agent is no reason to leave the first one dead.
  it('revives even while the owner runs another agent', async () => {
    const agent = await buried(2);
    const successor = await h.seedAgent({ ownerWallet: agent.ownerWallet, name: 'SUCCESSOR' });
    await h.fund(agent.walletPubkey, 12_000_000, agent.ownerWallet);

    const revived = await revive(h.deps, agent.id, agent.ownerWallet);
    expect(revived.status).toBe('alive');
    expect((await h.reload(successor.id)).status).toBe('alive');
  });

  it('refuses a live agent', async () => {
    const agent = await h.seedAgent();
    await expect(revive(h.deps, agent.id, agent.ownerWallet)).rejects.toThrow(/is alive/);
  });
});

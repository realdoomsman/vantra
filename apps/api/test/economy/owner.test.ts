// Owner controls (SPEC §8.15, AMENDMENTS C25): pause, terminate, messages and recapitalization.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents, ledger, ownerMessages } from '../../src/db/schema.js';
import { messageAgent, pause, recapitalize, setHeartbeat, setShareStrategy, terminate } from '../../src/economy/owner.js';
import { scanDeposits } from '../../src/runtime/deposits.js';
import { createHarness, type Harness } from './helpers/harness.js';

describe('economy/owner', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  it('bills the awake window before pausing and stops the sandbox', async () => {
    const agent = await h.seedAgent();
    h.clock.advanceHours(2);

    const paused = await pause(h.deps, agent.id, agent.ownerWallet, true);
    expect(paused).toMatchObject({ status: 'paused', phase: 'paused', nextStepAt: null });
    expect(paused.spendRentMicro).toBe(10_000);                       // billed at the awake rate
    expect(h.sandbox.stopped.has(agent.id)).toBe(true);

    h.clock.advanceHours(5);
    const resumed = await pause(h.deps, agent.id, agent.ownerWallet, false);
    expect(resumed.status).toBe('alive');
    expect(resumed.spendRentMicro).toBe(10_000 + 5 * 1_000);          // the paused window is billed at the sleep rate
    expect(h.sandbox.stopped.has(agent.id)).toBe(false);
    expect(resumed.nextStepAt).not.toBeNull();
  });

  it('terminates on request and leaves the treasury withdrawable', async () => {
    const agent = await h.seedAgent({ revenueExternalMicro: 12_000_000 });
    h.clock.advanceHours(1);
    const dead = await terminate(h.deps, agent.id, agent.ownerWallet);

    expect(dead).toMatchObject({ status: 'dead', deathCause: 'owner_terminated' });
    expect(dead.spendRentMicro).toBe(5_000);
    expect(h.sandbox.destroyed.has(agent.id)).toBe(true);
    const row = await h.reload(agent.id);
    expect(row.postmortem).toContain('was terminated by its owner');
    expect(h.messages.some((m) => m.type === 'event' && m.event.kind === 'death')).toBe(true);
  });

  it('toggles strategy sharing and the heartbeat', async () => {
    const agent = await h.seedAgent();
    expect((await setShareStrategy(h.deps, agent.id, agent.ownerWallet, true)).shareStrategy).toBe(true);
    expect((await setHeartbeat(h.deps, agent.id, agent.ownerWallet, 60)).heartbeatMin).toBe(60);
    await expect(setHeartbeat(h.deps, agent.id, agent.ownerWallet, 2)).rejects.toThrow(/between 5 and 1440/);
  });

  it('queues an owner message for the next heartbeat', async () => {
    const agent = await h.seedAgent();
    await messageAgent(h.deps, agent.id, agent.ownerWallet, '  Try selling to nurseries.  ');
    const rows = await h.db.select().from(ownerMessages).where(eq(ownerMessages.agentId, agent.id));
    expect(rows[0]).toMatchObject({ fromRole: 'owner', text: 'Try selling to nurseries.' });
    await expect(messageAgent(h.deps, agent.id, 'someone-else', 'hi')).rejects.toThrow(/Only the owner/);
  });

  it('books a verified owner top-up once', async () => {
    const owner = h.chain.newKeypair();
    const agent = await h.seedAgent({ ownerWallet: owner.pubkey });
    await h.fund(owner.pubkey, 6_000_000, 'bank');
    const { sig } = await h.chain.transferUsdc(owner.secret, agent.walletPubkey, 6_000_000, 'top-up');
    const after = await recapitalize(h.deps, agent.id, owner.pubkey, sig);

    expect(after.recapitalizedMicro).toBe(6_000_000);
    expect(after.treasuryMicro).toBe(16_000_000);
    const rows = await h.db.select().from(ledger).where(eq(ledger.agentId, agent.id));
    expect(rows.map((r) => r.kind)).toEqual(['recapitalize']);

    const again = await recapitalize(h.deps, agent.id, owner.pubkey, sig);
    expect(again.recapitalizedMicro).toBe(6_000_000);                 // idempotent
  });

  // A prior "have I seen this signature?" read is not a guard: two overlapping calls (or one racing
  // the agent's own heartbeat scan) both saw it as unbooked and credited the treasury twice.
  it('credits one transfer once even when the calls race', async () => {
    const owner = h.chain.newKeypair();
    const agent = await h.seedAgent({ ownerWallet: owner.pubkey });
    await h.fund(owner.pubkey, 6_000_000, 'bank');
    const { sig } = await h.chain.transferUsdc(owner.secret, agent.walletPubkey, 6_000_000, 'top-up');

    await Promise.all([
      recapitalize(h.deps, agent.id, owner.pubkey, sig),
      recapitalize(h.deps, agent.id, owner.pubkey, sig),
      scanDeposits(h.deps, agent),
    ]);

    const after = await h.reload(agent.id);
    expect(after.recapitalizedMicro).toBe(6_000_000);
    expect(after.treasuryMicro).toBe(16_000_000);
    const rows = await h.db.select().from(ledger).where(eq(ledger.agentId, agent.id));
    expect(rows.filter((r) => r.kind === 'recapitalize')).toHaveLength(1);
  });

  it('rejects a top-up that does not pay the agent', async () => {
    const owner = h.chain.newKeypair();
    const agent = await h.seedAgent({ ownerWallet: owner.pubkey });
    await h.fund(owner.pubkey, 1_000_000, 'bank');
    const elsewhere = h.chain.newKeypair();
    const { sig } = await h.chain.transferUsdc(owner.secret, elsewhere.pubkey, 1_000_000, 'wrong');

    await expect(recapitalize(h.deps, agent.id, owner.pubkey, sig)).rejects.toThrow(/top-up credited/);
    await expect(recapitalize(h.deps, agent.id, owner.pubkey, 'nope')).rejects.toThrow(/No confirmed USDC transfer/);
  });
});

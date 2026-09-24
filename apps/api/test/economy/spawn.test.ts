// Spawning (SPEC §8.4, SPEC-V2 §7.1). v2 has no holding gate, no seed pool and no one-agent rule:
// an agent exists because someone paid for it, so the job of this module is to make sure a paid
// purchase ALWAYS produces a working agent.
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FORK_ROYALTY_BPS } from '@vantra/shared';
import type { ApiError } from '../../src/lib/errors.js';
import type { SpawnInput } from '../../src/core/interfaces.js';
import { agentKeys, agents, decisions, forks, ledger, poolTxs, purchases } from '../../src/db/schema.js';
import { fundAndActivate, nameCandidates, retryStuckSpawn, spawn } from '../../src/economy/spawn.js';
import { scanDeposits } from '../../src/runtime/deposits.js';
import { createHarness, type Harness } from './helpers/harness.js';

const FUNDING = 9_000_000;          // what $10 buys after the 10% founder fee

const input = (over: Partial<SpawnInput> = {}): SpawnInput => ({
  ownerWallet: 'owner-1', ownerKind: 'wallet', name: 'ATLAS', directive: 'Sell weather data to farmers.',
  tools: ['bash', 'write_file'], model: 'mock-fast', effort: 'medium', heartbeatMin: 120,
  fundingMicro: FUNDING, tierId: 'SPARK', purchaseId: 'pu_test000001', ...over,
});

const code = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    return (e as ApiError).code;
  }
  throw new Error('expected the call to fail');
};

describe('economy/spawn', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  it('funds a bought agent out of the treasury and brings it alive', async () => {
    const agent = await spawn(h.deps, input());

    expect(agent).toMatchObject({
      name: 'ATLAS', status: 'alive', fundingMicro: FUNDING, treasuryMicro: FUNDING,
      generation: 1, tierId: 'SPARK', ownerKind: 'wallet', ownerWallet: 'owner-1', heartbeatMin: 120,
    });
    expect(agent.deploySlug).toBe('atlas');
    expect(await h.chain.getUsdcBalance(agent.walletPubkey)).toBe(FUNDING);
    expect(await h.chain.getEthBalance(agent.walletPubkey)).toBe(5_000_000);

    const rows = await h.db.select().from(ledger).where(eq(ledger.agentId, agent.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'funding', amountMicro: FUNDING, balanceAfterMicro: FUNDING, settled: true });
    expect(rows[0]!.meta).toMatchObject({ purchaseId: 'pu_test000001', tierId: 'SPARK' });

    const row = await h.reload(agent.id);
    expect(row.purchaseId).toBe('pu_test000001');
    expect(row.tier).toBe('SPARK');

    const keys = await h.db.select().from(agentKeys).where(eq(agentKeys.agentId, agent.id));
    expect(keys[0]!.pubkey).toBe(agent.walletPubkey);
    expect(keys[0]!.secretEnc.length).toBeGreaterThan(0);

    const kinds = (await h.db.select().from(poolTxs).orderBy(asc(poolTxs.id))).map((t) => t.kind);
    expect(kinds).toEqual(expect.arrayContaining(['funding', 'gas']));

    const events = h.messages.filter((m) => m.type === 'event').map((m) => (m.type === 'event' ? m.event.kind : ''));
    expect(events).toContain('spawn');
    const birth = await h.db.select().from(decisions).where(eq(decisions.agentId, agent.id));
    expect(birth[0]).toMatchObject({ kind: 'birth' });
  });

  it('marks a claim-owned agent as such and hides the purchase id from the public shape', async () => {
    const agent = await spawn(h.deps, input({ ownerWallet: 'claim_pu_test000001', ownerKind: 'claim' }));
    expect(agent).toMatchObject({ ownerKind: 'claim', ownerWallet: null });
    expect((await h.reload(agent.id)).ownerWallet).toBe('claim_pu_test000001');   // the row still joins
  });

  it('does not let the first deposit scan book the funding a second time', async () => {
    const agent = await spawn(h.deps, input());
    const row = await h.reload(agent.id);
    const scan = await scanDeposits(h.deps, row);

    expect(scan.deposits).toHaveLength(0);
    expect(scan.agent.treasuryMicro).toBe(FUNDING);
    expect(await h.db.select().from(ledger).where(eq(ledger.agentId, agent.id))).toHaveLength(1);
  });

  it('rejects bad names and reserved names', async () => {
    expect(await code(() => spawn(h.deps, input({ name: 'no' })))).toBe('BAD_REQUEST');
    expect(await code(() => spawn(h.deps, input({ name: 'VANTRA' })))).toBe('BAD_REQUEST');
  });

  // The name reservation on `purchases` normally prevents this, but a race that slips past it must
  // never cost the buyer their agent (SPEC-V2 §7.1.3).
  it('renames a paid spawn rather than refusing it when the name was taken', async () => {
    await spawn(h.deps, input({ name: 'ATLAS' }));
    const second = await spawn(h.deps, input({ name: 'atlas', ownerWallet: 'owner-2', purchaseId: 'pu_test000002' }));

    expect(second.name).toBe('ATLAS-2');
    expect(second.deploySlug).toBe('atlas-2');
    expect(second.status).toBe('alive');
    const renamed = h.messages.find((m) => m.type === 'event' && m.event.kind === 'spawn' && m.event.agentId === second.id);
    expect(renamed && renamed.type === 'event' ? renamed.event.meta['renamedFrom'] : null).toBe('ATLAS');
  });

  it('still refuses a free (demo) spawn whose name is taken', async () => {
    await spawn(h.deps, input({ name: 'ATLAS', purchaseId: null }));
    expect(await code(() => spawn(h.deps, input({ name: 'ATLAS', ownerWallet: 'owner-2', purchaseId: null })))).toBe('NAME_TAKEN');
  });

  it('offers suffixed then random candidates, all of them legal names', async () => {
    const candidates = nameCandidates('ATLAS');
    expect(candidates[0]).toBe('ATLAS');
    expect(candidates[1]).toBe('ATLAS-2');
    expect(candidates).toHaveLength(1 + 8 + 4);
    for (const c of candidates) expect(c).toMatch(/^(?=[A-Z0-9-]{3,16}$)[A-Z0-9]+(?:-[A-Z0-9]+)*$/);
    expect(nameCandidates('SIXTEENCHARSXYZ1').every((c) => c.length <= 16)).toBe(true);
  });

  it('rejects an over-long directive', async () => {
    expect(await code(() => spawn(h.deps, input({ directive: 'x'.repeat(601) })))).toBe('BAD_REQUEST');
  });

  // A purchase quoted against a provider whose key has since gone missing must still produce an
  // agent, so an unknown model degrades to the cheapest enabled one (SPEC-V2 §7.1.2).
  it('falls back to the cheapest model instead of throwing away the purchase', async () => {
    const agent = await spawn(h.deps, input({ model: 'gpt-9' }));
    expect(agent.status).toBe('alive');
    expect(agent.model).toBe(h.llm.cheapest().id);
  });

  it('lets one wallet own as many agents as it pays for', async () => {
    const first = await spawn(h.deps, input({ name: 'FIRST' }));
    const second = await spawn(h.deps, input({ name: 'SECOND', purchaseId: 'pu_test000002' }));
    const third = await spawn(h.deps, input({ name: 'THIRD', purchaseId: 'pu_test000003' }));

    expect([first, second, third].every((a) => a.status === 'alive')).toBe(true);
    expect(await h.db.select().from(agents)).toHaveLength(3);
  });

  it('survives a burst of concurrent spawns from one wallet', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => spawn(h.deps, input({ name: `RACER-${i}`, purchaseId: `pu_race00000${i}` }))),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    expect(await h.db.select().from(agents)).toHaveLength(6);
    const funding = (await h.db.select().from(poolTxs)).filter((t) => t.kind === 'funding');
    expect(funding).toHaveLength(6);
  });

  // The money is real and already somewhere, so a failed transfer must leave the agent retryable,
  // never dead (SPEC-V2 §7.1.6).
  it('leaves a failed funding transfer stuck in spawning and then finishes it', async () => {
    const transferUsdc = h.chain.transferUsdc.bind(h.chain);
    h.deps.chain.transferUsdc = async () => { throw new Error('rpc timeout'); };
    const failed = await spawn(h.deps, input());

    expect(failed).toMatchObject({ status: 'spawning', treasuryMicro: 0, fundingMicro: 0 });
    expect(failed.spawnError).toContain('rpc timeout');

    h.deps.chain.transferUsdc = transferUsdc;
    const revived = await fundAndActivate(h.deps, await h.reload(failed.id), FUNDING);
    expect(revived).toMatchObject({ status: 'alive', fundingMicro: FUNDING, spawnError: null });
    expect(await h.chain.getUsdcBalance(revived.walletPubkey)).toBe(FUNDING);
  });

  it('never marks a repeatedly failing spawn dead', async () => {
    h.deps.chain.transferUsdc = async () => { throw new Error('rpc down'); };
    const failed = await spawn(h.deps, input());
    for (let i = 0; i < 4; i++) await fundAndActivate(h.deps, await h.reload(failed.id), FUNDING);

    const row = await h.reload(failed.id);
    expect(row.status).toBe('spawning');
    expect(row.deathCause).toBeNull();
    expect(row.spawnAttempts).toBeGreaterThanOrEqual(4);
  });

  it('reads the amount a retry owes back off the purchase row', async () => {
    const transferUsdc = h.chain.transferUsdc.bind(h.chain);
    h.deps.chain.transferUsdc = async () => { throw new Error('rpc down'); };
    const failed = await spawn(h.deps, input({ purchaseId: 'pu_owed000001' }));
    await h.db.insert(purchases).values({
      id: 'pu_owed000001', status: 'spawned', expiresAt: new Date(h.clock.now().getTime() + 86_400_000),
      depositPubkey: 'deposit-owed', quotedMicro: 10_000_000, amountMicro: 10_000_000, feeBps: 1_000,
      feeMicro: 1_000_000, fundingMicro: FUNDING, quotedTier: 'SPARK', tier: 'SPARK', agentId: failed.id,
      createdAt: h.clock.now(),
    });

    h.deps.chain.transferUsdc = transferUsdc;
    const alive = await retryStuckSpawn(h.deps, await h.reload(failed.id));
    expect(alive.status).toBe('alive');
    expect(alive.fundingMicro).toBe(FUNDING);
  });

  it('inherits a forked strategy, bumps the generation and records the royalty', async () => {
    const parent = await spawn(h.deps, input({ name: 'PARENT' }));
    const strategy = `Sell weather summaries to farmers.\n${'Details about the pipeline. '.repeat(30)}`;
    await h.db.update(agents).set({ shareStrategy: true, strategy }).where(eq(agents.id, parent.id));

    const child = await spawn(h.deps, input({ name: 'CHILD', ownerWallet: 'owner-2', forkOf: parent.id, purchaseId: 'pu_test000002' }));
    expect(child).toMatchObject({ generation: 2, forkedFrom: parent.id });

    const row = await h.reload(child.id);
    expect(row.memory[0]).toBe('Forked strategy from PARENT:');
    expect(row.memory.length).toBeGreaterThan(1);
    expect(row.memory.every((note) => note.length <= 300)).toBe(true);

    const [fork] = await h.db.select().from(forks).where(eq(forks.childAgentId, child.id));
    expect(fork).toMatchObject({ parentAgentId: parent.id, royaltyBps: FORK_ROYALTY_BPS });

    const forkEvents = h.messages.filter((m) => m.type === 'event' && m.event.kind === 'fork');
    expect(forkEvents).toHaveLength(2);        // one on the child, one on the parent
  });

  it('refuses to fork a parent that is not sharing', async () => {
    const parent = await spawn(h.deps, input({ name: 'PARENT' }));
    expect(await code(() => spawn(h.deps, input({ name: 'CHILD', ownerWallet: 'owner-2', forkOf: parent.id })))).toBe('NOT_ELIGIBLE');
  });
});

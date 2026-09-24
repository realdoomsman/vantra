// Settlement (SPEC §8.11): sweep unsettled spend to the fee wallet, pay fork royalties child→parent,
// top up gas from the treasury and reconcile with the chain.
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTLE_THRESHOLD_MICRO, ETH_GAS_STIPEND_GWEI } from '@vantra/shared';
import { agents, depositsSeen, forks, ledger } from '../../src/db/schema.js';
import { recordFork } from '../../src/economy/fork.js';
import { post } from '../../src/economy/ledger.js';
import { treasuryService } from '../../src/economy/treasury.js';
import { wallets } from '../../src/economy/wallets.js';
import { scanDeposits } from '../../src/runtime/deposits.js';
import { runSettlement, settleAgent } from '../../src/runtime/settlement.js';
import { EXTERNAL_PAYER, createHarness, type Harness } from '../economy/helpers/harness.js';

describe('runtime/settlement', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  const kinds = async (agentId: string) =>
    (await h.db.select().from(ledger).where(eq(ledger.agentId, agentId)).orderBy(asc(ledger.id))).map((r) => r.kind);

  it('sweeps accrued spend to the protocol fee wallet and clears it', async () => {
    const agent = await h.seedAgent();
    await post(h.deps, h.db, { agentId: agent.id, kind: 'inference', amountMicro: -SETTLE_THRESHOLD_MICRO, memo: 'spend' });
    const feeWallet = wallets(h.deps).protocolFee;

    const report = await runSettlement(h.deps);
    expect(report.sweptMicro).toBe(SETTLE_THRESHOLD_MICRO);
    expect(await h.chain.getUsdcBalance(feeWallet)).toBe(SETTLE_THRESHOLD_MICRO);
    expect(await h.chain.getUsdcBalance(agent.walletPubkey)).toBe(10_000_000 - SETTLE_THRESHOLD_MICRO);

    const after = await h.reload(agent.id);
    expect(after.unsettledMicro).toBe(0);
    expect(after.treasuryMicro).toBe(10_000_000 - SETTLE_THRESHOLD_MICRO);   // the spend already left the books
    expect(after.lastSettledAt).not.toBeNull();
    expect(await kinds(agent.id)).toEqual(['inference', 'settlement']);
    const rows = await h.db.select().from(ledger).where(eq(ledger.agentId, agent.id));
    expect(rows.every((r) => r.settled)).toBe(true);
  });

  it('leaves small, freshly settled balances alone', async () => {
    const agent = await h.seedAgent();
    await post(h.deps, h.db, { agentId: agent.id, kind: 'rent', amountMicro: -1_000, memo: 'rent' });
    await h.db.update(agents).set({ lastSettledAt: h.clock.now() }).where(eq(agents.id, agent.id));

    const report = await runSettlement(h.deps);
    expect(report.considered).toBe(0);
    expect((await h.reload(agent.id)).unsettledMicro).toBe(1_000);
  });

  it('pays the fork royalty on chain exactly once', async () => {
    const parent = await h.seedAgent({ name: 'PARENT' });
    const child = await h.seedAgent({ name: 'CHILD', forkedFrom: parent.id });
    await recordFork(h.db, parent.id, child.id);
    await h.fund(child.walletPubkey, 2_000_000, EXTERNAL_PAYER);
    const earned = await scanDeposits(h.deps, child);
    expect(earned.agent.royaltyOutMicro).toBe(100_000);

    await settleAgent(h.deps, earned.agent);
    expect(await h.chain.getUsdcBalance(parent.walletPubkey)).toBe(10_100_000);
    const [fork] = await h.db.select().from(forks).where(eq(forks.childAgentId, child.id));
    expect(fork!.royaltiesPaidMicro).toBe(100_000);

    // The parent's inflow is pre-marked as seen, so the deposit scan cannot book it as revenue again.
    const seen = await h.db.select().from(depositsSeen).where(eq(depositsSeen.agentId, parent.id));
    expect(seen).toHaveLength(1);
    const parentAfter = await scanDeposits(h.deps, await h.reload(parent.id));
    expect(parentAfter.deposits).toHaveLength(0);
    expect(parentAfter.agent.revenueInternalMicro).toBe(0);
    expect(parentAfter.agent.treasuryMicro).toBe(10_100_000);

    // A second settlement pass has nothing left to pay.
    const again = await settleAgent(h.deps, await h.reload(child.id));
    expect(again.royaltiesMicro).toBe(0);
  });

  // `settled` has to keep meaning "this money moved". Marking every unpaid royalty_in on the parent
  // when ONE child pays hid sibling B's debt and made the parent's reconcile report a false shortfall.
  it('settles only the paying child’s rows on a parent with two forks', async () => {
    const parent = await h.seedAgent({ name: 'PARENT' });
    const childA = await h.seedAgent({ name: 'CHILD-A', forkedFrom: parent.id });
    const childB = await h.seedAgent({ name: 'CHILD-B', forkedFrom: parent.id });
    await recordFork(h.db, parent.id, childA.id);
    await recordFork(h.db, parent.id, childB.id);
    await h.fund(childA.walletPubkey, 2_000_000, EXTERNAL_PAYER);
    await h.fund(childB.walletPubkey, 4_000_000, EXTERNAL_PAYER);
    const earnedA = await scanDeposits(h.deps, childA);
    await scanDeposits(h.deps, childB);

    await settleAgent(h.deps, earnedA.agent);

    const parentRoyalties = await h.db.select().from(ledger)
      .where(and(eq(ledger.agentId, parent.id), eq(ledger.kind, 'royalty_in')));
    const settled = parentRoyalties.filter((r) => r.settled);
    const outstanding = parentRoyalties.filter((r) => !r.settled);
    expect(settled.map((r) => r.meta['childAgentId'])).toEqual([childA.id]);
    expect(outstanding.map((r) => r.meta['childAgentId'])).toEqual([childB.id]);
    expect(outstanding[0]!.amountMicro).toBe(200_000);         // 5% of child B's $4, still owed

    // B pays later and only then is the parent's book clear.
    await settleAgent(h.deps, await h.reload(childB.id));
    const after = await h.db.select().from(ledger)
      .where(and(eq(ledger.agentId, parent.id), eq(ledger.kind, 'royalty_in')));
    expect(after.every((r) => r.settled)).toBe(true);
  });

  it('tops up gas from the treasury and bills it to the agent', async () => {
    await treasuryService(h.deps).sync();                   // the treasury row learns it holds SOL
    const agent = await h.seedAgent();
    await post(h.deps, h.db, { agentId: agent.id, kind: 'inference', amountMicro: -SETTLE_THRESHOLD_MICRO, memo: 'spend' });

    const result = await settleAgent(h.deps, await h.reload(agent.id));
    expect(result.gasMicro).toBeGreaterThan(0);
    expect(await h.chain.getEthBalance(agent.walletPubkey)).toBe(ETH_GAS_STIPEND_GWEI);
    expect(await kinds(agent.id)).toEqual(['inference', 'settlement', 'gas']);
    expect((await h.reload(agent.id)).spendGasMicro).toBe(result.gasMicro);
  });

  it('reports the drift between the chain and the books', async () => {
    const agent = await h.seedAgent();
    await h.chain.faucet(agent.walletPubkey, 500_000, 'unbooked-donor');   // arrives without a deposit scan
    const result = await settleAgent(h.deps, agent);
    expect(result.driftMicro).toBe(500_000);
    expect((await h.reload(agent.id)).onchainUsdcMicro).toBe(10_500_000);
  });

  it('reports no drift for the USDC it just swept', async () => {
    const agent = await h.seedAgent();
    await post(h.deps, h.db, { agentId: agent.id, kind: 'inference', amountMicro: -SETTLE_THRESHOLD_MICRO, memo: 'spend' });

    const result = await settleAgent(h.deps, await h.reload(agent.id));
    expect(result.sweptMicro).toBe(SETTLE_THRESHOLD_MICRO);
    expect(result.driftMicro).toBe(0);
    expect((await h.reload(agent.id)).onchainUsdcMicro).toBe(10_000_000 - SETTLE_THRESHOLD_MICRO);
  });

  it('writes off spend an agent died owing with an empty wallet', async () => {
    const agent = await h.seedAgent({ status: 'dead', treasuryMicro: 0, fund: 0 });   // wallet drained before death
    await post(h.deps, h.db, { agentId: agent.id, kind: 'rent', amountMicro: -SETTLE_THRESHOLD_MICRO, memo: 'rent' });

    const result = await settleAgent(h.deps, await h.reload(agent.id));
    expect(result.sweptMicro).toBe(0);
    const after = await h.reload(agent.id);
    expect(after.unsettledMicro).toBe(0);
    expect(await kinds(agent.id)).toEqual(['rent', 'settlement']);
    expect(await runSettlement(h.deps)).toMatchObject({ considered: 0 });   // and never comes back
  });
});

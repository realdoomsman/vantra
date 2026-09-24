// Public read side: phase (AMENDMENTS C20), burn basis (B15), global stats and the daily series (C22).
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents, decisions, projects, purchases } from '../../src/db/schema.js';
import { toPublicMany, toPublicOne } from '../../src/economy/agents.js';
import { post } from '../../src/economy/ledger.js';
import { setPayoutWallet } from '../../src/economy/owner.js';
import { graveyard, leaderboard, listAgents, me, series, stats } from '../../src/economy/stats.js';
import { treasuryService } from '../../src/economy/treasury.js';
import { wallets } from '../../src/economy/wallets.js';
import { newProjectId } from '../../src/lib/ids.js';
import { createHarness, type Harness } from './helpers/harness.js';

const DAY = 86_400_000;
const PAYOUT_WALLET = '0x1111111111111111111111111111111111111111';   // 20 bytes of hex: a legal EVM address

describe('economy/stats', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  const addProject = (agentId: string, over: { status?: 'idea' | 'building' | 'live'; revenueMicro?: number; kind?: 'site' | 'api' } = {}) =>
    h.db.insert(projects).values({
      id: newProjectId(), agentId, name: 'thing', kind: over.kind ?? 'site', status: over.status ?? 'idea',
      description: '', revenueMicro: over.revenueMicro ?? 0, createdAt: h.clock.now(), updatedAt: h.clock.now(),
    });

  it('computes the phase in priority order', async () => {
    const dead = await h.seedAgent({ name: 'DEAD', status: 'dead' });
    const paused = await h.seedAgent({ name: 'PAUSED', status: 'paused' });
    const sleeping = await h.seedAgent({ name: 'SLEEPY', status: 'sleeping' });
    const spawning = await h.seedAgent({ name: 'NEW', status: 'spawning' });
    const pivoting = await h.seedAgent({ name: 'PIVOT' });
    const operating = await h.seedAgent({ name: 'SELLER' });
    const building = await h.seedAgent({ name: 'BUILDER' });
    const exploring = await h.seedAgent({ name: 'EXPLORER' });

    await h.db.insert(decisions).values({ agentId: pivoting.id, kind: 'pivot', text: 'new plan', ts: h.clock.now() });
    await addProject(operating.id, { status: 'live', revenueMicro: 1_000 });
    await addProject(building.id, { status: 'building' });
    await addProject(exploring.id, { status: 'idea' });

    const rows = await toPublicMany(h.deps, [dead, paused, sleeping, spawning, pivoting, operating, building, exploring]);
    expect(rows.map((r) => r.phase)).toEqual(['dead', 'paused', 'sleeping', 'spawning', 'pivoting', 'operating', 'building', 'exploring']);
  });

  it('projects burn on day one and switches to trailing spend after that', async () => {
    const young = await h.seedAgent({ name: 'YOUNG', bornAt: new Date(h.clock.now().getTime() - DAY / 2) });
    const youngPub = await toPublicOne(h.deps, young);
    expect(youngPub.burnBasis).toBe('projected');
    // v2 rates: $0.12/day rent and a 60-minute default heartbeat instead of $0.48 and 15 minutes.
    expect(youngPub.burnPerDayMicro).toBe(120_000 + (1440 / 60) * 13_500);   // rent/day + steps/day × estimate(6000,1500)
    expect(youngPub.runwayDays).toBeCloseTo(10_000_000 / youngPub.burnPerDayMicro, 1);

    const old = await h.seedAgent({ name: 'OLD', bornAt: new Date(h.clock.now().getTime() - 2 * DAY) });
    await post(h.deps, h.db, { agentId: old.id, kind: 'inference', amountMicro: -100_000, memo: 'spend' });
    const oldPub = await toPublicOne(h.deps, old);
    expect(oldPub.burnBasis).toBe('trailing');
    expect(oldPub.burnPerDayMicro).toBe(50_000);                             // 100_000 over two days
  });

  it('reports colony totals, strategies and the protocol rules', async () => {
    const alive = await h.seedAgent({ name: 'ALIVE', revenueExternalMicro: 3_000_000, bornAt: new Date(h.clock.now().getTime() - 2 * DAY) });
    await addProject(alive.id, { status: 'live', revenueMicro: 2_000, kind: 'api' });
    const dead = await h.seedAgent({ name: 'GONE', status: 'dead' });
    await h.db.update(agents).set({ diedAt: h.clock.now(), deathCause: 'insolvent' }).where(eq(agents.id, dead.id));
    await h.seedAgent({ name: 'NAPPING', status: 'sleeping' });
    await post(h.deps, h.db, { agentId: alive.id, kind: 'inference', amountMicro: -250_000, memo: 'spend' });

    const snapshot = await stats(h.deps);
    expect(snapshot).toMatchObject({ born: 3, alive: 2, dead: 1, sleeping: 1, spendInferenceMicro: 250_000 });
    expect(snapshot.revenueExternalMicro).toBe(3_000_000);
    expect(snapshot.spendTotalMicro).toBe(250_000);
    expect(snapshot.topEarner).toMatchObject({ name: 'ALIVE', revenueExternalMicro: 3_000_000 });
    expect(snapshot.oldestAlive).toMatchObject({ name: 'ALIVE' });
    expect(snapshot.strategies[0]).toMatchObject({ kind: 'api', projects: 1, earning: 1, agentsAlive: 1, revenueExternalMicro: 3_000_000 });
    expect(snapshot.rules).toMatchObject({
      minPurchaseMicro: 10_000_000, maxPurchaseMicro: 1_000_000_000, founderFeeBps: 1_000,
      withdrawFeeBps: 250, forkRoyaltyBps: 500, stepCostTreasuryBps: 200,
    });
    expect(snapshot.chain).toMatchObject({ mode: 'memory' });
    expect(snapshot.llm.provider).toBe('mock');
    expect(snapshot.treasury.usdcMicro).toBeGreaterThanOrEqual(0);
    // No purchases in this fixture, so the sales counters exist and are honestly zero.
    expect(snapshot).toMatchObject({ agentsBought: 0, grossSalesMicro: 0, founderFeesMicro: 0 });
  });

  // The three sales counters are the Landing and Observatory headline ("N AGENTS BOUGHT — $X gross"),
  // so they must count money that actually landed and nothing else. They read the treasury's books,
  // which is also where the seeded colony's sales are recorded (SPEC-V2 §7.8).
  it('counts a booked purchase as a sale and a half-paid pending one as nothing', async () => {
    const treasury = treasuryService(h.deps);
    await h.db.insert(purchases).values({
      id: 'pu_pendingxxx', kind: 'spawn', path: 'deposit', status: 'pending',
      createdAt: h.clock.now(), expiresAt: new Date(h.clock.now().getTime() + DAY),
      depositPubkey: 'Deposit111', quotedMicro: 25_000_000,
      amountMicro: 4_000_000,                      // $4 of a $25 purchase: seen on chain, not a sale
      feeBps: 1_000, quotedTier: 'SCOUT', pace: 'steady', agentName: 'PENDER',
    });
    expect(await stats(h.deps)).toMatchObject({ agentsBought: 0, grossSalesMicro: 0, founderFeesMicro: 0 });

    await treasury.recordPurchase({
      purchaseId: 'pu_realonexxx', grossMicro: 25_000_000, feeMicro: 2_500_000,
      usdcInflowMicro: 22_500_000, txSig: null, kind: 'purchase',
    });
    // A top-up is money, not another agent: it moves the gross and the fee, never the count.
    await treasury.recordPurchase({
      purchaseId: 'pu_topupxxxxx', grossMicro: 10_000_000, feeMicro: 1_000_000,
      usdcInflowMicro: 9_000_000, txSig: null, kind: 'topup',
    });

    expect(await stats(h.deps)).toMatchObject({
      agentsBought: 1, grossSalesMicro: 35_000_000, founderFeesMicro: 3_500_000,
    });
  });

  // The Market page cannot build the escrow transfer POST /api/market/bounties demands without
  // knowing where to send it (SPEC §8.15, §9). Pubkeys only — never a secret.
  it('publishes the escrow, protocol fee and founder fee wallets, and never a secret', async () => {
    const snapshot = await stats(h.deps);
    const protocol = wallets(h.deps);

    expect(snapshot.chain.escrowWallet).toBe(protocol.escrow.pubkey);
    expect(snapshot.chain.protocolFeeWallet).toBe(protocol.protocolFee);
    expect(snapshot.chain.founderFeeWallet).toBe(protocol.founderFee);
    expect(snapshot.chain.escrowWallet).not.toBe(snapshot.treasury.walletPubkey);   // a different key (SPEC §8.7)
    expect(JSON.stringify(snapshot)).not.toContain(Buffer.from(protocol.escrow.secret).toString('base64'));
    expect(JSON.stringify(snapshot)).not.toContain(Buffer.from(protocol.treasury.secret).toString('base64'));
  });

  it('builds a daily series with cumulative alive counts', async () => {
    const yesterday = new Date(h.clock.now().getTime() - DAY);
    const old = await h.seedAgent({ name: 'FIRST', bornAt: yesterday });
    await h.seedAgent({ name: 'SECOND' });
    await h.db.update(agents).set({ status: 'dead', diedAt: h.clock.now(), deathCause: 'rent' }).where(eq(agents.id, old.id));
    await post(h.deps, h.db, { agentId: old.id, kind: 'inference', amountMicro: -40_000, memo: 'spend' });

    const points = await series(h.deps, 2);
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ born: 1, died: 0, alive: 1 });
    expect(points[1]).toMatchObject({ born: 1, died: 1, alive: 1, spendInferenceMicro: 40_000, spendMicro: 40_000 });
  });

  it('lists, ranks and buries agents', async () => {
    const rich = await h.seedAgent({ name: 'RICH', treasuryMicro: 30_000_000, revenueExternalMicro: 8_000_000 });
    await h.seedAgent({ name: 'POOR', treasuryMicro: 1_000_000 });
    const gone = await h.seedAgent({ name: 'GONE', status: 'dead', revenueExternalMicro: 100 });
    await h.db.update(agents).set({ diedAt: h.clock.now(), deathCause: 'insolvent' }).where(eq(agents.id, gone.id));

    const alive = await listAgents(h.deps, { status: 'alive', sort: 'treasury' });
    expect(alive.total).toBe(2);
    expect(alive.rows[0]!.name).toBe('RICH');

    const searched = await listAgents(h.deps, { status: 'all', q: 'poor' });
    expect(searched.rows.map((r) => r.name)).toEqual(['POOR']);

    const byRevenue = await leaderboard(h.deps, 'revenue', 10);
    expect(byRevenue[0]!.id).toBe(rich.id);

    const graves = await graveyard(h.deps, 10, 'recent');
    expect(graves.map((g) => g.name)).toEqual(['GONE']);
    expect(graves[0]!.phase).toBe('dead');
    expect(graves[0]!.postmortem).toBeNull();                 // the field is on the row (D37), not fetched per card

    await h.db.update(agents).set({ postmortem: 'GONE died after 3 days. It never found a buyer.' }).where(eq(agents.id, gone.id));
    const withText = await graveyard(h.deps, 10, 'recent');
    expect(withText[0]!.postmortem).toContain('never found a buyer');
  });

  // v2 has no per-owner limit: Me is a list of everything this identity bought, newest first.
  it('answers Me with every agent the identity owns', async () => {
    const free = await me(h.deps, 'fresh-wallet');
    expect(free).toMatchObject({ ownerId: 'fresh-wallet', ownerKind: 'wallet', wallet: 'fresh-wallet', payoutWallet: null });
    expect(free.agents).toEqual([]);
    expect(free.purchases).toEqual([]);

    const first = await h.seedAgent({ ownerWallet: 'busy-wallet', name: 'BUSY' });
    h.clock.advanceHours(1);
    const second = await h.seedAgent({ ownerWallet: 'busy-wallet', name: 'BUSIER' });
    const busy = await me(h.deps, 'busy-wallet');
    expect(busy.agents.map((a) => a.id)).toEqual([second.id, first.id]);       // newest first
  });

  // A claim identity has no pubkey of its own; `Me.wallet` is null until it names a payout wallet,
  // and the owner id (which IS the purchase id) never reaches the public agent shape.
  it('answers Me for a claim identity without leaking the purchase id', async () => {
    const ownerId = 'claim_pu_abcdefghij';
    const agent = await h.seedAgent({ ownerWallet: ownerId, ownerKind: 'claim', name: 'CLAIMED', payoutWallet: null });

    const mine = await me(h.deps, ownerId);
    expect(mine).toMatchObject({ ownerId, ownerKind: 'claim', wallet: null, payoutWallet: null });
    expect(mine.agents.map((a) => a.id)).toEqual([agent.id]);
    expect(mine.agents[0]!.ownerWallet).toBeNull();
    expect(mine.agents[0]!.ownerKind).toBe('claim');

    await setPayoutWallet(h.deps, ownerId, PAYOUT_WALLET);
    expect((await me(h.deps, ownerId)).payoutWallet).toBe(PAYOUT_WALLET);
  });
});

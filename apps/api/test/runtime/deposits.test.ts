// Deposit classification (SPEC §8.7): every unseen inflow becomes exactly one ledger row, milestones
// fire on external revenue crossings and forks accrue their royalty.
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents, bounties, depositsSeen, ledger, projects, serviceCalls, services } from '../../src/db/schema.js';
import { recordFork } from '../../src/economy/fork.js';
import { wallets } from '../../src/economy/wallets.js';
import { scanDeposits } from '../../src/runtime/deposits.js';
import { EXTERNAL_PAYER, createHarness, type Harness } from '../economy/helpers/harness.js';

describe('runtime/deposits', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  const kinds = async (agentId: string) =>
    (await h.db.select().from(ledger).where(eq(ledger.agentId, agentId)).orderBy(asc(ledger.id))).map((r) => r.kind);

  it('books an allow-listed payer as external revenue and emits a revenue event', async () => {
    const agent = await h.seedAgent();
    await h.fund(agent.walletPubkey, 2_500_000, EXTERNAL_PAYER);
    const { agent: after, deposits } = await scanDeposits(h.deps, agent);

    expect(deposits).toHaveLength(1);
    expect(deposits[0]).toMatchObject({ classified: 'external', kind: 'revenue_external', amountMicro: 2_500_000 });
    expect(after.revenueExternalMicro).toBe(2_500_000);
    expect(after.treasuryMicro).toBe(12_500_000);
    expect(after.onchainUsdcMicro).toBe(12_500_000);
    expect(h.messages.some((m) => m.type === 'event' && m.event.kind === 'revenue')).toBe(true);
  });

  // The headline metric must not be mintable with a second keypair (ECONOMICS-REVIEW).
  it('books an unattributed sender as pending, never as external revenue', async () => {
    const agent = await h.seedAgent();
    await h.fund(agent.walletPubkey, 2_500_000, 'burner-wallet');
    const { agent: after, deposits } = await scanDeposits(h.deps, agent);

    expect(deposits[0]).toMatchObject({ classified: 'pending', kind: 'revenue_pending' });
    expect(after.revenuePendingMicro).toBe(2_500_000);
    expect(after.revenueExternalMicro).toBe(0);
    expect(after.treasuryMicro).toBe(12_500_000);            // spendable all the same
    expect(h.messages.some((m) => m.type === 'event' && m.event.kind === 'revenue')).toBe(false);
    expect(h.messages.some((m) => m.type === 'event' && m.event.kind === 'milestone')).toBe(false);
  });

  it('promotes a pending deposit once the matching user service call exists', async () => {
    const seller = await h.seedAgent({ name: 'SELLER' });
    const buyer = 'human-buyer-wallet';
    const now = h.clock.now();
    await h.db.insert(services).values({
      id: 'sv_promote01', agentId: seller.id, name: 'digest', description: 'd', priceMicro: 400_000,
      handlerPath: 'svc/h.js', status: 'active', createdAt: now,
    });
    const sig = await h.fund(seller.walletPubkey, 400_000, buyer);

    const first = await scanDeposits(h.deps, seller);
    expect(first.agent.revenuePendingMicro).toBe(400_000);

    await h.db.insert(serviceCalls).values({
      serviceId: 'sv_promote01', buyerType: 'user', buyerId: buyer, priceMicro: 400_000, status: 'ok',
      paymentTx: sig, ts: now,
    });
    const second = await scanDeposits(h.deps, first.agent);

    expect(second.agent.revenuePendingMicro).toBe(0);
    expect(second.agent.revenueExternalMicro).toBe(400_000);
    expect(await kinds(seller.id)).toEqual(['revenue_external']);
  });

  it('refuses to promote a service call paid by a wallet that runs an agent', async () => {
    const seller = await h.seedAgent({ name: 'SELLER' });
    const other = await h.seedAgent({ name: 'OTHER', ownerWallet: 'colluding-owner' });
    const now = h.clock.now();
    await h.db.insert(services).values({
      id: 'sv_wash00001', agentId: seller.id, name: 'digest', description: 'd', priceMicro: 400_000,
      handlerPath: 'svc/h.js', status: 'active', createdAt: now,
    });
    const sig = await h.fund(seller.walletPubkey, 400_000, other.ownerWallet);
    await h.db.insert(serviceCalls).values({
      serviceId: 'sv_wash00001', buyerType: 'user', buyerId: other.ownerWallet, priceMicro: 400_000, status: 'ok',
      paymentTx: sig, ts: now,
    });
    const { agent: after } = await scanDeposits(h.deps, seller);

    expect(after.revenueExternalMicro).toBe(0);
    expect(after.revenuePendingMicro).toBe(400_000);
    expect(await h.db.select().from(agents).where(eq(agents.id, other.id))).toHaveLength(1);
  });

  it('credits the agent’s live project so the strategy stats and the operating phase mean something', async () => {
    const agent = await h.seedAgent();
    const now = h.clock.now();
    await h.db.insert(projects).values([
      { id: 'pj_oldabandon', agentId: agent.id, name: 'Old', kind: 'site', status: 'abandoned', description: 'x', createdAt: now, updatedAt: now },
      { id: 'pj_liveproduc', agentId: agent.id, name: 'Live', kind: 'api', status: 'live', description: 'x', createdAt: now, updatedAt: now },
    ]);
    await h.fund(agent.walletPubkey, 1_250_000, EXTERNAL_PAYER);
    await scanDeposits(h.deps, agent);

    const rows = await h.db.select().from(projects).where(eq(projects.agentId, agent.id));
    expect(rows.find((r) => r.id === 'pj_liveproduc')!.revenueMicro).toBe(1_250_000);
    expect(rows.find((r) => r.id === 'pj_oldabandon')!.revenueMicro).toBe(0);
  });

  it('books the owner as a recapitalization, not revenue', async () => {
    const agent = await h.seedAgent();
    await h.fund(agent.walletPubkey, 5_000_000, agent.ownerWallet);
    const { agent: after } = await scanDeposits(h.deps, agent);

    expect(after.recapitalizedMicro).toBe(5_000_000);
    expect(after.revenueExternalMicro).toBe(0);
    expect(await kinds(agent.id)).toEqual(['recapitalize']);
    expect(h.messages.some((m) => m.type === 'event' && m.event.kind === 'recapitalize')).toBe(true);
  });

  it('books another agent as internal revenue', async () => {
    const seller = await h.seedAgent({ name: 'SELLER' });
    const buyer = await h.seedAgent({ name: 'BUYER' });
    await h.fund(seller.walletPubkey, 300_000, buyer.walletPubkey);
    const { agent: after, deposits } = await scanDeposits(h.deps, seller);

    expect(after.revenueInternalMicro).toBe(300_000);
    expect(after.revenueExternalMicro).toBe(0);
    expect(deposits[0]!.memo).toBe('transfer from BUYER');
  });

  it('books the treasury as the funding the first time and as a top-up after that', async () => {
    const agent = await h.seedAgent({ fundingMicro: 0, treasuryMicro: 0, fund: 0 });
    const treasury = wallets(h.deps).treasury;
    await h.chain.transferUsdc(treasury.secret, agent.walletPubkey, 9_000_000, 'VANTRA funding');
    const first = await scanDeposits(h.deps, agent);
    expect(first.agent.fundingMicro).toBe(9_000_000);

    await h.chain.transferUsdc(treasury.secret, agent.walletPubkey, 1_000_000, 'top-up');
    const second = await scanDeposits(h.deps, first.agent);
    expect(second.agent.fundingMicro).toBe(9_000_000);
    expect(second.agent.recapitalizedMicro).toBe(1_000_000);
    expect(await kinds(agent.id)).toEqual(['funding', 'recapitalize']);
  });

  it('classifies an escrow payout by who posted the bounty', async () => {
    const claimer = await h.seedAgent({ name: 'CLAIMER' });
    const poster = await h.seedAgent({ name: 'POSTER' });
    const now = h.clock.now();
    await h.db.insert(bounties).values([
      {
        id: 'bt_user', posterType: 'user', posterId: 'human-wallet', title: 'Write docs', description: 'd',
        rewardMicro: 400_000, status: 'paid', claimerAgentId: claimer.id, createdAt: now, deadlineAt: now, paidAt: now,
      },
      {
        id: 'bt_agent', posterType: 'agent', posterId: poster.id, title: 'Scrape prices', description: 'd',
        rewardMicro: 150_000, status: 'paid', claimerAgentId: claimer.id, createdAt: now, deadlineAt: now, paidAt: now,
      },
    ]);
    const escrow = wallets(h.deps).escrow;
    await h.fund(escrow.pubkey, 1_000_000, 'poster-escrow');
    await h.chain.transferUsdc(escrow.secret, claimer.walletPubkey, 400_000, 'bounty bt_user');
    await h.chain.transferUsdc(escrow.secret, claimer.walletPubkey, 150_000, 'bounty bt_agent');
    const { agent: after } = await scanDeposits(h.deps, claimer);

    expect(after.revenueExternalMicro).toBe(400_000);      // a human customer paid
    expect(after.revenueInternalMicro).toBe(150_000);      // another agent paid
    expect(await kinds(claimer.id)).toEqual(['escrow_in', 'escrow_in']);
  });

  it('books escrow money coming back for its own expired bounty as a refund', async () => {
    const poster = await h.seedAgent({ name: 'POSTER' });
    const now = h.clock.now();
    await h.db.insert(bounties).values({
      id: 'bt_expired', posterType: 'agent', posterId: poster.id, title: 'Nobody claimed this', description: 'd',
      rewardMicro: 250_000, status: 'expired', createdAt: now, deadlineAt: now, escrowTx: 'escrow-out-sig',
    });
    await h.fund(wallets(h.deps).escrow.pubkey, 250_000, 'poster-escrow');
    await h.chain.transferUsdc(wallets(h.deps).escrow.secret, poster.walletPubkey, 250_000, 'refund');
    const { agent: after } = await scanDeposits(h.deps, poster);

    expect(await kinds(poster.id)).toEqual(['refund']);
    expect(after.revenueInternalMicro).toBe(0);
    expect(after.spendPaymentsMicro).toBe(-250_000);       // the escrow_out it paid earlier is undone
  });

  // A `rejected` bounty still holds its reward in escrow — the claimer may resubmit — so it can never
  // explain an inflow. Matching it turned a genuine payout into a refund and erased the revenue.
  it('does not book a bounty payout as a refund because a rejected bounty happens to match', async () => {
    const agent = await h.seedAgent({ name: 'BOTH-SIDES' });
    const now = h.clock.now();
    await h.db.insert(bounties).values([
      {
        // Posted by this agent, first submission rejected: escrow has NOT refunded anything.
        id: 'bt_rejected01', posterType: 'agent', posterId: agent.id, title: 'My own job', description: 'd',
        rewardMicro: 1_000_000, status: 'rejected', claimerAgentId: null, createdAt: now, deadlineAt: now,
        escrowTx: 'sig-escrow-out', rejections: 1,
      },
      {
        // Claimed by this agent and approved: this is the money actually arriving.
        id: 'bt_claimed001', posterType: 'user', posterId: 'human-wallet', title: 'Write the docs', description: 'd',
        rewardMicro: 1_000_000, status: 'paid', claimerAgentId: agent.id, createdAt: now, deadlineAt: now, paidAt: now,
      },
    ]);
    const escrow = wallets(h.deps).escrow;
    await h.fund(escrow.pubkey, 1_000_000, 'poster-escrow');
    await h.chain.transferUsdc(escrow.secret, agent.walletPubkey, 1_000_000, 'bounty bt_claimed001');

    const { agent: after, deposits } = await scanDeposits(h.deps, agent);

    expect(deposits[0]).toMatchObject({ kind: 'escrow_in', memo: 'bounty payout: Write the docs' });
    expect(after.revenueExternalMicro).toBe(1_000_000);
    expect(after.spendPaymentsMicro).toBe(0);              // not a negative spend aggregate
    expect(await kinds(agent.id)).toEqual(['escrow_in']);
  });

  it('fires milestone events on crossings and when the agent has paid for itself', async () => {
    const agent = await h.seedAgent({ fundingMicro: 10_000_000 });
    await h.fund(agent.walletPubkey, 1_500_000, EXTERNAL_PAYER);
    const first = await scanDeposits(h.deps, agent);
    await h.fund(agent.walletPubkey, 9_000_000, EXTERNAL_PAYER);
    await scanDeposits(h.deps, first.agent);

    const milestones = h.messages.filter((m) => m.type === 'event' && m.event.kind === 'milestone')
      .map((m) => (m.type === 'event' ? m.event.text : ''));
    expect(milestones.some((t) => t.includes('$1.00'))).toBe(true);
    expect(milestones.some((t) => t.includes('$10.00'))).toBe(true);
    expect(milestones.some((t) => t.includes('PAID BACK WHAT IT COST'))).toBe(true);
  });

  it('accrues the fork royalty on both sides of external revenue', async () => {
    const parent = await h.seedAgent({ name: 'PARENT' });
    const child = await h.seedAgent({ name: 'CHILD', forkedFrom: parent.id });
    await recordFork(h.db, parent.id, child.id);
    await h.fund(child.walletPubkey, 1_000_000, EXTERNAL_PAYER);
    const { agent: after } = await scanDeposits(h.deps, child);

    expect(after.royaltyOutMicro).toBe(50_000);            // 5%
    expect(after.treasuryMicro).toBe(10_000_000 + 1_000_000 - 50_000);
    const parentRow = await h.reload(parent.id);
    expect(parentRow.royaltyInMicro).toBe(50_000);
    expect(parentRow.treasuryMicro).toBe(10_050_000);
    expect(await kinds(child.id)).toEqual(['revenue_external', 'royalty_out']);
  });

  it('never books the same signature twice', async () => {
    const agent = await h.seedAgent();
    await h.fund(agent.walletPubkey, 750_000, EXTERNAL_PAYER);
    const first = await scanDeposits(h.deps, agent);
    const second = await scanDeposits(h.deps, first.agent);
    const third = await scanDeposits(h.deps, second.agent);

    expect(second.deposits).toHaveLength(0);
    expect(third.deposits).toHaveLength(0);
    expect(third.agent.revenueExternalMicro).toBe(750_000);
    expect(await h.db.select().from(depositsSeen).where(eq(depositsSeen.agentId, agent.id))).toHaveLength(1);
  });
});

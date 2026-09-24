// The market (SPEC §8.9, §8.15): human bounties are escrowed on chain before they exist, reviewed by
// the poster, and refunded when they expire.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bounties, ledger } from '../../src/db/schema.js';
import { expireBounties, listBounties, postBounty, reviewBounty } from '../../src/economy/market.js';
import { wallets } from '../../src/economy/wallets.js';
import { scanDeposits } from '../../src/runtime/deposits.js';
import { createHarness, type Harness } from './helpers/harness.js';

describe('economy/market', () => {
  let h: Harness;
  let buyer: { pubkey: string; secret: Uint8Array };
  beforeEach(async () => {
    h = await createHarness();
    buyer = h.chain.newKeypair();
    await h.fund(buyer.pubkey, 5_000_000, 'bank');
  });
  afterEach(async () => { await h.close(); });

  const escrowSig = async (amount: number) =>
    (await h.chain.transferUsdc(buyer.secret, wallets(h.deps).escrow.pubkey, amount, 'escrow')).sig;

  const bounty = (escrowTxSig: string, over: Partial<Parameters<typeof postBounty>[1]> = {}) => ({
    posterType: 'user' as const, posterWallet: buyer.pubkey, title: 'Summarise 50 papers',
    description: 'One page each, cited.', rewardMicro: 1_000_000, deadlineHours: 48, escrowTxSig, ...over,
  });

  it('accepts a bounty once its reward is in escrow', async () => {
    const sig = await escrowSig(1_000_000);
    const posted = await postBounty(h.deps, bounty(sig));

    expect(posted).toMatchObject({ posterType: 'user', status: 'open', rewardMicro: 1_000_000 });
    expect(posted.deadlineAt > posted.createdAt).toBe(true);
    expect(await listBounties(h.deps, 'open')).toHaveLength(1);
    expect(h.messages.some((m) => m.type === 'event' && m.event.kind === 'bounty')).toBe(true);
  });

  it('rejects escrow transactions that do not back the reward', async () => {
    const stranger = h.chain.newKeypair();
    await h.fund(stranger.pubkey, 2_000_000, 'bank');
    const wrongSender = (await h.chain.transferUsdc(stranger.secret, wallets(h.deps).escrow.pubkey, 1_000_000, 'escrow')).sig;
    const wrongTarget = (await h.chain.transferUsdc(buyer.secret, stranger.pubkey, 1_000_000, 'nope')).sig;
    const tooSmall = await escrowSig(500_000);

    await expect(postBounty(h.deps, bounty('no-such-sig'))).rejects.toThrow(/No confirmed USDC transfer/);
    await expect(postBounty(h.deps, bounty(wrongSender))).rejects.toThrow(/escrow transfer was sent by/);
    await expect(postBounty(h.deps, bounty(wrongTarget))).rejects.toThrow(/escrow transfer credited/);
    await expect(postBounty(h.deps, bounty(tooSmall))).rejects.toThrow(/at least \$1\.00 is required/);
  });

  it('refuses to fund two bounties with one transaction', async () => {
    const sig = await escrowSig(1_000_000);
    await postBounty(h.deps, bounty(sig));
    await expect(postBounty(h.deps, bounty(sig, { title: 'Another job' }))).rejects.toThrow(/already funds/);
  });

  // Approval pays out of the SHARED escrow wallet, so a read-then-insert that N concurrent posts walk
  // through would hand one deposit N rewards of other posters' money.
  it('refuses to fund two bounties with one transaction even when the posts race', async () => {
    const sig = await escrowSig(1_000_000);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => postBounty(h.deps, bounty(sig, { title: `Concurrent job ${i}` }))),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(String(r.reason)).toMatch(/already funds/);
    }
    expect(await h.db.select().from(bounties)).toHaveLength(1);
  });

  it('pays the claimer out of escrow when the poster approves', async () => {
    const claimer = await h.seedAgent({ name: 'WORKER' });
    const posted = await postBounty(h.deps, bounty(await escrowSig(1_000_000)));
    await h.db.update(bounties)
      .set({ status: 'submitted', claimerAgentId: claimer.id, submission: 'here it is', claimedAt: h.clock.now() })
      .where(eq(bounties.id, posted.id));

    const paid = await reviewBounty(h.deps, posted.id, buyer.pubkey, true, 'great work');
    expect(paid).toMatchObject({ status: 'paid', feedback: 'great work' });
    expect(paid.paidAt).not.toBeNull();
    expect(await h.chain.getUsdcBalance(claimer.walletPubkey)).toBe(11_000_000);
  });

  it('gives one resubmission before reopening a rejected bounty', async () => {
    const claimer = await h.seedAgent({ name: 'WORKER' });
    const posted = await postBounty(h.deps, bounty(await escrowSig(1_000_000)));
    const submit = () => h.db.update(bounties)
      .set({ status: 'submitted', claimerAgentId: claimer.id, submission: 'draft' })
      .where(eq(bounties.id, posted.id));

    await submit();
    const first = await reviewBounty(h.deps, posted.id, buyer.pubkey, false, 'thin');
    expect(first).toMatchObject({ status: 'claimed', claimerAgentId: claimer.id });

    await submit();
    const second = await reviewBounty(h.deps, posted.id, buyer.pubkey, false, 'still thin');
    expect(second).toMatchObject({ status: 'open', claimerAgentId: null, submission: null });
  });

  it('only lets the poster review', async () => {
    const posted = await postBounty(h.deps, bounty(await escrowSig(1_000_000)));
    await h.db.update(bounties).set({ status: 'submitted', claimerAgentId: (await h.seedAgent()).id }).where(eq(bounties.id, posted.id));
    await expect(reviewBounty(h.deps, posted.id, 'someone-else', true, '')).rejects.toThrow(/Only the poster/);
  });

  it('refunds an expired bounty to its poster', async () => {
    const userBounty = await postBounty(h.deps, bounty(await escrowSig(1_000_000)));
    const agent = await h.seedAgent({ name: 'POSTER' });
    await h.fund(wallets(h.deps).escrow.pubkey, 400_000, 'agent-escrow');
    await h.db.insert(bounties).values({
      id: 'bt_agentposted', posterType: 'agent', posterId: agent.id, title: 'Find leads', description: 'd',
      rewardMicro: 400_000, status: 'open', createdAt: h.clock.now(), deadlineAt: h.clock.now(), escrowTx: 'sig-agent',
    });

    h.clock.advanceHours(72);
    const expired = await expireBounties(h.deps);
    expect(expired).toBe(2);

    const rows = await h.db.select().from(bounties);
    expect(rows.every((r) => r.status === 'expired')).toBe(true);
    expect(await h.chain.getUsdcBalance(buyer.pubkey)).toBe(5_000_000);         // the human got the reward back
    const refunds = await h.db.select().from(ledger).where(eq(ledger.agentId, agent.id));
    expect(refunds.map((r) => r.kind)).toEqual(['refund']);
    expect(refunds[0]!.amountMicro).toBe(400_000);
    expect(userBounty.status).toBe('open');                                     // the snapshot from before expiry
  });

  // A reward parked in `rejected` or `submitted` used to sit in the shared escrow wallet forever: the
  // deadline passes, nobody can resubmit, and no poster ever reviews it.
  it('sweeps rejected bounties at the deadline and submitted ones after the review grace', async () => {
    const claimer = await h.seedAgent({ name: 'WORKER' });
    const now = h.clock.now();
    await h.fund(wallets(h.deps).escrow.pubkey, 2_000_000, 'agent-escrow');
    const row = (id: string, status: 'rejected' | 'submitted') => ({
      id, posterType: 'user' as const, posterId: buyer.pubkey, title: `${status} job`, description: 'd',
      rewardMicro: 300_000, status, claimerAgentId: claimer.id, createdAt: now, deadlineAt: now, escrowTx: `sig-${id}`,
    });
    await h.db.insert(bounties).values([row('bt_rejected001', 'rejected'), row('bt_submitted01', 'submitted')]);

    h.clock.advanceHours(1);
    expect(await expireBounties(h.deps)).toBe(1);                       // rejected only: the poster still has time
    expect((await h.db.select().from(bounties).where(eq(bounties.id, 'bt_rejected001')))[0]!.status).toBe('expired');
    expect((await h.db.select().from(bounties).where(eq(bounties.id, 'bt_submitted01')))[0]!.status).toBe('submitted');

    h.clock.advanceHours(48);
    expect(await expireBounties(h.deps)).toBe(1);
    expect((await h.db.select().from(bounties).where(eq(bounties.id, 'bt_submitted01')))[0]!.status).toBe('expired');
    expect(await h.chain.getUsdcBalance(buyer.pubkey)).toBe(5_600_000);  // both rewards refunded
  });

  // The refund lands on chain too, so the poster's next deposit scan would book it a second time and
  // leave the books above the wallet forever.
  it('books an expired bounty refund once, not again on the next deposit scan', async () => {
    const agent = await h.seedAgent({ name: 'POSTER', fund: 0 });
    await h.fund(wallets(h.deps).escrow.pubkey, 400_000, 'agent-escrow');
    await h.db.insert(bounties).values({
      id: 'bt_expiring', posterType: 'agent', posterId: agent.id, title: 'Find leads', description: 'd',
      rewardMicro: 400_000, status: 'open', createdAt: h.clock.now(), deadlineAt: h.clock.now(), escrowTx: 'sig-agent',
    });

    h.clock.advanceHours(72);
    const before = (await h.reload(agent.id)).treasuryMicro;
    await expireBounties(h.deps);
    const scanned = await scanDeposits(h.deps, await h.reload(agent.id));

    const refunds = await h.db.select().from(ledger).where(eq(ledger.agentId, agent.id));
    expect(refunds.filter((r) => r.kind === 'refund')).toHaveLength(1);
    expect(scanned.deposits).toHaveLength(0);                       // the scan recognises the refund as already booked
    expect(scanned.agent.treasuryMicro - before).toBe(400_000);     // credited once, not twice
  });
});

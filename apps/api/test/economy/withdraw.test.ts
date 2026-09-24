// Withdrawals (SPEC §8.11, SPEC-V2 §6.2): age + payback eligibility, the 30-day reserve, the 2.5%
// fee to the treasury, and the payout wallet a claim identity must set before it can be paid.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESERVE_MIN_MICRO, WITHDRAW_FEE_BPS } from '@vantra/shared';
import { loadAgentSecret } from '../../src/chain/keystore.js';
import { agents, ledger, poolTxs, withdrawals } from '../../src/db/schema.js';
import { toPublicOne } from '../../src/economy/agents.js';
import { withdraw, withdrawableOf } from '../../src/economy/withdraw.js';
import { wallets } from '../../src/economy/wallets.js';
import { createHarness, type Harness } from './helpers/harness.js';

const DAY = 86_400_000;

const keyOf = async (h: Harness, agentId: string): Promise<Uint8Array> =>
  loadAgentSecret(h.db, h.config.keyEncryptionKey, agentId);

describe('economy/withdraw', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  const mature = (over: Parameters<Harness['seedAgent']>[0] = {}) => h.seedAgent({
    bornAt: new Date(h.clock.now().getTime() - 10 * DAY),
    treasuryMicro: 25_000_000, fundingMicro: 10_000_000, revenueExternalMicro: 15_000_000, ...over,
  });

  it('refuses before the minimum age', async () => {
    const agent = await h.seedAgent({ revenueExternalMicro: 15_000_000 });
    const pub = await toPublicOne(h.deps, agent);
    const state = withdrawableOf(agent, pub.burnPerDayMicro, h.clock.now(), null);
    expect(state.eligible).toBe(false);
    expect(state.reason).toContain('7 days old');
  });

  it('refuses until external revenue covers what the agent cost', async () => {
    const agent = await mature({ revenueExternalMicro: 4_000_000 });
    const state = withdrawableOf(agent, 0, h.clock.now(), null);
    expect(state.eligible).toBe(false);
    expect(state.reason).toContain('that was paid for this agent');
  });

  it('keeps a 30-day reserve, never below one seed', async () => {
    const agent = await mature();
    expect(withdrawableOf(agent, 0, h.clock.now(), null)).toMatchObject({
      eligible: true, reserveMicro: RESERVE_MIN_MICRO, amountMicro: 15_000_000,
    });
    expect(withdrawableOf(agent, 600_000, h.clock.now(), null)).toMatchObject({
      eligible: true, reserveMicro: 18_000_000, amountMicro: 7_000_000,
    });
    expect(withdrawableOf({ ...agent, unsettledMicro: 2_000_000 }, 0, h.clock.now(), null).amountMicro).toBe(13_000_000);
  });

  it('pays the owner, sends the fee to the treasury and books both sides', async () => {
    const agent = await mature();
    const poolWallet = wallets(h.deps).treasury.pubkey;
    const poolBefore = await h.chain.getUsdcBalance(poolWallet);

    const result = await withdraw(h.deps, agent.id, agent.ownerWallet);
    const fee = Math.round((15_000_000 * WITHDRAW_FEE_BPS) / 10_000);
    expect(result).toMatchObject({ sentMicro: 15_000_000 - fee, feeMicro: fee });
    expect(result.txSig).toBeTruthy();

    expect(await h.chain.getUsdcBalance(agent.ownerWallet)).toBe(15_000_000 - fee);
    expect(await h.chain.getUsdcBalance(poolWallet)).toBe(poolBefore + fee);

    const rows = await h.db.select().from(ledger).where(eq(ledger.agentId, agent.id));
    expect(rows.map((r) => r.kind)).toEqual(['withdrawal', 'withdrawal_fee']);
    const after = await h.reload(agent.id);
    expect(after.withdrawnMicro).toBe(15_000_000 - fee);
    expect(after.treasuryMicro).toBe(10_000_000);

    const [record] = await h.db.select().from(withdrawals).where(eq(withdrawals.agentId, agent.id));
    expect(record).toMatchObject({ status: 'sent', feeMicro: fee });
    const fees = await h.db.select().from(poolTxs).where(eq(poolTxs.kind, 'withdraw_fee'));
    expect(fees[0]).toMatchObject({ amountMicro: fee, agentId: agent.id });
    expect(h.messages.some((m) => m.type === 'event' && m.event.kind === 'withdraw')).toBe(true);
  });

  it('honours a partial amount', async () => {
    const agent = await mature();
    const result = await withdraw(h.deps, agent.id, agent.ownerWallet, 1_000_000);
    expect(result).toMatchObject({ sentMicro: 975_000, feeMicro: 25_000 });
    expect((await h.reload(agent.id)).treasuryMicro).toBe(24_000_000);
  });

  it('caps a greedy request at what is withdrawable', async () => {
    const agent = await mature();
    const result = await withdraw(h.deps, agent.id, agent.ownerWallet, 99_000_000);
    expect(result.sentMicro + result.feeMicro).toBe(15_000_000);
  });

  it('lets an owner-terminated agent pay out everything with no age rule', async () => {
    const agent = await h.seedAgent({
      status: 'dead', treasuryMicro: 3_000_000, fundingMicro: 10_000_000, revenueExternalMicro: 12_000_000,
    });
    await h.db.update(agents).set({ deathCause: 'owner_terminated' }).where(eq(agents.id, agent.id));
    const dead = await h.reload(agent.id);

    const state = withdrawableOf(dead, 500_000, h.clock.now(), null);
    expect(state).toMatchObject({ eligible: true, reserveMicro: 0, amountMicro: 3_000_000 });
    const result = await withdraw(h.deps, dead.id, dead.ownerWallet);
    expect(result.sentMicro + result.feeMicro).toBe(3_000_000);
  });

  // Two overlapping calls — a double-clicked button is enough — used to read the same withdrawable
  // balance and both send, leaving the agent under the reserve SPEC §8.11 exists to protect.
  it('never sends more than the withdrawable amount when two withdrawals race', async () => {
    const agent = await mature();                              // $25 treasury, $10 reserve → $15 out
    const results = await Promise.allSettled([
      withdraw(h.deps, agent.id, agent.ownerWallet, 9_000_000),
      withdraw(h.deps, agent.id, agent.ownerWallet, 9_000_000),
      withdraw(h.deps, agent.id, agent.ownerWallet, 9_000_000),
    ]);

    const sent = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.sentMicro + r.value.feeMicro] : []));
    expect(sent.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(15_000_000);
    const after = await h.reload(agent.id);
    expect(after.treasuryMicro).toBeGreaterThanOrEqual(RESERVE_MIN_MICRO);
    expect(await h.chain.getUsdcBalance(agent.walletPubkey)).toBe(after.treasuryMicro);
  });

  it('records a failed withdrawal instead of losing it', async () => {
    const agent = await mature();
    // The agent's wallet is empty on chain, so the transfer fails while the books still say $25.
    await h.chain.transferUsdc(await keyOf(h, agent.id), 'somewhere-else-wallet', 25_000_000, 'drain');
    await expect(withdraw(h.deps, agent.id, agent.ownerWallet, 1_000_000)).rejects.toThrow();

    const [record] = await h.db.select().from(withdrawals).where(eq(withdrawals.agentId, agent.id));
    expect(record).toMatchObject({ status: 'failed' });
    expect((await h.reload(agent.id)).treasuryMicro).toBe(25_000_000);   // the debit rolled back with it
  });

  it('refuses a dead-broke agent', async () => {
    const agent = await h.seedAgent({ status: 'dead', treasuryMicro: 100, revenueExternalMicro: 12_000_000 });
    await expect(withdraw(h.deps, agent.id, agent.ownerWallet)).rejects.toThrow(/dead/);
  });
});

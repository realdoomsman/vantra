// The deposit poller and fulfilment (SPEC-V2 §5.3, §5.4) against the memory chain and a real database.
// This is where the money actually moves: buyer → deposit address → founder fee + treasury → agent.
import { desc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIN_PURCHASE_MICRO, SWEEP_DUST_MICRO, claimOwnerId, tierById, usd,
} from '@vantra/shared';
import { gweiToMicro } from '../../src/chain/price.js';
import { agents, events, poolTxs, purchases, users } from '../../src/db/schema.js';
import { treasuryService } from '../../src/economy/treasury.js';
import { createPaymentsHarness, fundTreasury, type PaymentsHarness } from './helpers.js';

let h: PaymentsHarness;
const BUYER = 'exchange-withdrawal';

afterEach(async () => { await h?.close(); });
beforeEach(async () => {
  h = await createPaymentsHarness();
  await fundTreasury(h, usd(100));        // an operator float: needed for gas and for SOL-paid fees
});

const buy = (over: Record<string, unknown> = {}) =>
  h.payments.createPurchase({
    amountMicro: usd(25), name: 'TESTER', directive: 'Find someone who will pay for a thing.',
    path: 'deposit', ...over,
  });

const pay = async (pubkey: string, amountMicro: number, from = BUYER) => h.chain.faucet(pubkey, amountMicro, from);
const treasuryTxs = () => h.db.select().from(poolTxs).orderBy(desc(poolTxs.id));

describe('poller: waiting for the money', () => {
  it('persists a partial payment and stays pending so the page can say how much is missing', async () => {
    const { purchase } = await buy();
    await pay(purchase.depositPubkey!, usd(4));
    await h.payments.pollNow();

    const seen = (await h.payments.getPurchase(purchase.id))!;
    expect(seen).toMatchObject({ status: 'pending', receivedMicro: usd(4), quotedMicro: usd(25) });
    expect(seen.depositPubkey).toBe(purchase.depositPubkey);
    const row = await h.loadPurchase(purchase.id);
    expect(row).toMatchObject({ usdcMicro: usd(4), amountMicro: usd(4), refundTo: BUYER, tier: null });
    expect(row.lastPolledAt).not.toBeNull();
    expect(h.spawns).toHaveLength(0);
  });

  it('completes the purchase when the rest of the money turns up', async () => {
    const { purchase } = await buy();
    await pay(purchase.depositPubkey!, usd(4));
    await h.payments.pollNow();
    await pay(purchase.depositPubkey!, usd(21));
    await h.payments.pollNow();

    expect((await h.payments.getPurchase(purchase.id))!.status).toBe('spawned');
    expect(h.spawns).toHaveLength(1);
  });

  it('does nothing at all for an unpaid purchase that has not expired', async () => {
    const { purchase } = await buy();
    await h.payments.pollNow();
    const row = await h.loadPurchase(purchase.id);
    expect(row).toMatchObject({ status: 'pending', amountMicro: 0, refundTo: null });
    expect(row.depositSecretEnc).not.toBeNull();
  });
});

describe('poller: a paid purchase becomes an agent', () => {
  it('splits the money, funds the agent and records every side of it', async () => {
    const { purchase } = await buy();
    await pay(purchase.depositPubkey!, usd(25));
    await h.payments.pollNow();

    const done = (await h.payments.getPurchase(purchase.id))!;
    expect(done).toMatchObject({
      status: 'spawned', receivedMicro: usd(25), feeMicro: usd(2.5), fundingMicro: usd(22.5),
      tierId: 'SCOUT', depositPubkey: null, spawnError: null,
    });
    expect(done.agentId).toMatch(/^ag_/);

    // The chain: nothing left at the deposit address, the fee with the founder, the funding with the agent.
    const [agent] = await h.db.select().from(agents).where(eq(agents.id, done.agentId!));
    expect(await h.chain.getUsdcBalance(purchase.depositPubkey!)).toBe(0);
    expect(await h.chain.getUsdcBalance(h.chain.wallets.founderFee)).toBe(usd(2.5));
    expect(await h.chain.getUsdcBalance(agent!.walletPubkey)).toBe(usd(22.5));

    // The books: gross and fee on the treasury, the net as one `purchase` row.
    const view = await treasuryService(h.deps).current();
    expect(view).toMatchObject({ purchasesMicro: usd(25), founderFeesMicro: usd(2.5), agentsFunded: 1, fundedMicro: usd(22.5) });
    const [tx] = await treasuryTxs();
    expect((await treasuryTxs()).filter((t) => t.kind === 'purchase')).toEqual([
      expect.objectContaining({ kind: 'purchase', amountMicro: usd(22.5), meta: { purchaseId: purchase.id, grossMicro: usd(25), feeMicro: usd(2.5) } }),
    ]);
    expect(tx).toBeTruthy();

    // The row: no secret left anywhere, the signatures kept.
    const row = await h.loadPurchase(purchase.id);
    expect(row.depositSecretEnc).toBeNull();
    expect(row.depositIv).toBeNull();
    expect(row.depositTag).toBeNull();
    expect(row.sweepSig).toBeTruthy();
    expect(row.fundingSig).toBeTruthy();
    expect(row.ownerId).toBe(claimOwnerId(purchase.id));
  });

  it('hands spawn everything it needs, derived from what actually arrived', async () => {
    const { purchase } = await buy();
    await pay(purchase.depositPubkey!, usd(25));
    await h.payments.pollNow();

    expect(h.spawns[0]).toMatchObject({
      ownerWallet: claimOwnerId(purchase.id), ownerKind: 'claim', name: 'TESTER',
      directive: 'Find someone who will pay for a thing.', tools: tierById('SCOUT')!.enabledTools,
      model: 'mock-fast', effort: 'medium', fundingMicro: usd(22.5), tierId: 'SCOUT', purchaseId: purchase.id,
    });
    expect(h.spawns[0]!.heartbeatMin).toBeGreaterThan(0);
  });

  it('creates the claim identity as a real user row so a session can be minted against it', async () => {
    const { purchase } = await buy();
    await pay(purchase.depositPubkey!, usd(25));
    await h.payments.pollNow();

    const [user] = await h.db.select().from(users).where(eq(users.wallet, claimOwnerId(purchase.id)));
    expect(user).toMatchObject({ kind: 'claim', purchaseId: purchase.id });
  });

  it('announces the purchase in the feed with the tier and both numbers', async () => {
    const { purchase } = await buy();
    await pay(purchase.depositPubkey!, usd(25));
    await h.payments.pollNow();

    const [event] = await h.db.select().from(events).where(eq(events.kind, 'purchase'));
    expect(event).toMatchObject({
      kind: 'purchase', agentName: 'TESTER', amountMicro: usd(25),
      text: 'TESTER was bought for $25.00 — $22.50 into its treasury (SCOUT)',
      meta: { purchaseId: purchase.id, tierId: 'SCOUT', feeMicro: usd(2.5) },
    });
  });

  it('upgrades the tier when the buyer overpays, and never takes a tool away', async () => {
    const { purchase } = await buy({ tools: ['fetch_url', 'wallet', 'web_search'] });
    await pay(purchase.depositPubkey!, usd(60));
    await h.payments.pollNow();

    const row = await h.loadPurchase(purchase.id);
    expect(row).toMatchObject({ status: 'spawned', quotedTier: 'SCOUT', tier: 'OPERATOR', amountMicro: usd(60), feeMicro: usd(6), fundingMicro: usd(54) });
    expect(row.model).toBe('mock-strong');                       // OPERATOR resolves a strong model
    expect(row.tools).toEqual(expect.arrayContaining(['fetch_url', 'wallet', 'web_search', 'bash', 'deploy_site']));
    expect(row.tools).not.toContain('post_bounty');              // PRIME only
    expect(h.spawns[0]).toMatchObject({ tierId: 'OPERATOR', fundingMicro: usd(54) });
  });

  it('is idempotent: a second tick changes nothing', async () => {
    const { purchase } = await buy();
    await pay(purchase.depositPubkey!, usd(25));
    await h.payments.pollNow();
    const after = await h.loadPurchase(purchase.id);

    await h.payments.pollNow();
    await h.payments.pollNow(purchase.id);

    expect(await h.loadPurchase(purchase.id)).toEqual(after);
    expect(h.spawns).toHaveLength(1);
    expect(await h.db.select().from(agents)).toHaveLength(1);
    expect((await treasuryTxs()).filter((t) => t.kind === 'purchase')).toHaveLength(1);
    const view = await treasuryService(h.deps).current();
    expect(view).toMatchObject({ purchasesMicro: usd(25), founderFeesMicro: usd(2.5) });
  });

  it('values an ETH payment and settles the founder fee out of the treasury', async () => {
    const { purchase } = await buy();
    const gwei = 10_000_000;                                  // 0.01 ETH at $3000 = $30
    const value = gweiToMicro(gwei, await h.chain.ethPriceUsd());
    await h.chain.faucetEth(purchase.depositPubkey!, gwei);
    await h.payments.pollNow();

    const row = await h.loadPurchase(purchase.id);
    expect(row).toMatchObject({ status: 'spawned', usdcMicro: 0, ethGwei: gwei, ethValueMicro: value, amountMicro: value });
    expect(await h.chain.getEthBalance(purchase.depositPubkey!)).toBe(0);
    // No USDC ever reached the deposit address, so the fee comes out of the treasury instead.
    expect(await h.chain.getUsdcBalance(h.chain.wallets.founderFee)).toBe(row.feeMicro);
    const [agent] = await h.db.select().from(agents).where(eq(agents.id, row.agentId!));
    expect(await h.chain.getUsdcBalance(agent!.walletPubkey)).toBe(row.fundingMicro);
    expect(row.meta).toMatchObject({ feeShortfallMicro: row.feeMicro });
  });

  it('ignores ETH dust below the deposit floor', async () => {
    const { purchase } = await buy();
    await h.chain.faucetEth(purchase.depositPubkey!, 1_000_000);   // 0.001 ETH, under DEPOSIT_ETH_MIN_GWEI
    await h.payments.pollNow();
    expect(await h.loadPurchase(purchase.id)).toMatchObject({ status: 'pending', ethValueMicro: 0, amountMicro: 0 });
  });
});

describe('poller: fulfilment that fails', () => {
  it('keeps the money safe, shows the error and retries on the next tick', async () => {
    const { purchase } = await buy();
    h.failNextSpawn('the sandbox exploded');
    await pay(purchase.depositPubkey!, usd(25));
    await h.payments.pollNow();

    const failed = await h.loadPurchase(purchase.id);
    expect(failed).toMatchObject({ status: 'received', agentId: null, spawnAttempts: 1, spawnError: 'the sandbox exploded' });
    expect(failed.depositSecretEnc).toBeNull();                    // swept: the money is in the treasury
    expect((await h.payments.getPurchase(purchase.id))!.spawnError).toBe('the sandbox exploded');

    await h.payments.pollNow();                                     // the stalled-fulfilment sweep retries it
    const recovered = await h.loadPurchase(purchase.id);
    expect(recovered).toMatchObject({ status: 'spawned', spawnError: null });
    expect((await treasuryTxs()).filter((t) => t.kind === 'purchase')).toHaveLength(1);
  });

  it('gives up after MAX_FULFIL_ATTEMPTS rather than retrying for ever', async () => {
    const { purchase } = await buy();
    await pay(purchase.depositPubkey!, usd(25));
    for (let i = 0; i < 7; i++) {
      h.failNextSpawn('nope');
      await h.payments.pollNow();
    }
    const row = await h.loadPurchase(purchase.id);
    expect(row.status).toBe('received');
    expect(row.spawnAttempts).toBe(5);
  });
});

describe('poller: expiry, refunds and sweeps', () => {
  const expireNow = async () => { h.clock.advanceHours(73); await h.payments.pollNow(); };

  it('expires an unpaid purchase and wipes its key material', async () => {
    const { purchase } = await buy();
    await expireNow();

    const row = await h.loadPurchase(purchase.id);
    expect(row).toMatchObject({ status: 'expired', amountMicro: 0, refundSig: null, sweepSig: null });
    expect(row.depositSecretEnc).toBeNull();
    expect((await h.payments.getPurchase(purchase.id))!.depositPubkey).toBeNull();
  });

  it('refunds an underpayment above dust to whoever sent it', async () => {
    const { purchase } = await buy();
    await pay(purchase.depositPubkey!, usd(4));
    await h.payments.pollNow();
    await expireNow();

    const row = await h.loadPurchase(purchase.id);
    expect(row).toMatchObject({ status: 'refunded', refundTo: BUYER });
    expect(row.refundSig).toBeTruthy();
    expect(await h.chain.getUsdcBalance(BUYER)).toBe(usd(4));
    expect(await h.chain.getUsdcBalance(purchase.depositPubkey!)).toBe(0);
    expect(row.depositSecretEnc).toBeNull();

    const [event] = await h.db.select().from(events).where(eq(events.kind, 'purchase'));
    expect(event!.text).toContain('Underpaid purchase refunded: $4.00 back to');
    expect((await treasuryTxs()).filter((t) => t.kind === 'sweep')).toHaveLength(0);
  });

  it('sweeps true dust to the treasury instead of paying to refund it', async () => {
    const { purchase } = await buy();
    const dust = SWEEP_DUST_MICRO - 1;
    await pay(purchase.depositPubkey!, dust);
    await expireNow();

    const row = await h.loadPurchase(purchase.id);
    expect(row).toMatchObject({ status: 'expired', amountMicro: dust });
    expect(row.sweepSig).toBeTruthy();
    expect(await h.chain.getUsdcBalance(BUYER)).toBe(0);
    expect((await treasuryTxs()).filter((t) => t.kind === 'sweep')).toEqual([
      expect.objectContaining({ kind: 'sweep', amountMicro: dust }),
    ]);
    expect(await h.chain.getUsdcBalance(h.chain.wallets.treasury.pubkey)).toBe(usd(100) + dust);
  });

  it('never refunds money that already bought an agent', async () => {
    const { purchase } = await buy();
    await pay(purchase.depositPubkey!, usd(25));
    await h.payments.pollNow();
    await expireNow();

    expect((await h.loadPurchase(purchase.id)).status).toBe('spawned');
    expect(await h.chain.getUsdcBalance(BUYER)).toBe(0);
  });

  it('treats a cancellation as an early expiry, refund and all', async () => {
    const { purchase } = await buy();
    await pay(purchase.depositPubkey!, usd(4));
    await h.payments.pollNow();

    const cancelled = await h.payments.cancelPurchase(purchase.id, claimOwnerId(purchase.id));
    expect(cancelled.status).toBe('refunded');
    expect(await h.chain.getUsdcBalance(BUYER)).toBe(usd(4));
  });
});

describe('poller: top-ups', () => {
  it('credits an existing agent and leaves the founder fee behind', async () => {
    const agent = await h.seedAgent({ name: 'INCUMBENT', ownerWallet: 'owner-wallet' });
    const topUp = await h.payments.topUp(agent.id, 'owner-wallet', usd(10), 'deposit');
    await pay(topUp.depositPubkey!, usd(10));
    await h.payments.pollNow();

    const row = await h.loadPurchase(topUp.id);
    expect(row).toMatchObject({ status: 'spawned', kind: 'topup', feeMicro: usd(1), fundingMicro: usd(9), agentId: agent.id });
    expect(h.topUps).toEqual([{ agentId: agent.id, purchaseId: topUp.id, amountMicro: usd(9) }]);
    expect(h.spawns).toHaveLength(0);
    expect(await h.chain.getUsdcBalance(h.chain.wallets.founderFee)).toBe(usd(1));
    expect(await h.chain.getUsdcBalance(agent.walletPubkey)).toBe(usd(9));

    const [event] = await h.db.select().from(events).where(eq(events.kind, 'topup'));
    expect(event).toMatchObject({ text: 'INCUMBENT was topped up with $9.00', amountMicro: usd(9) });
    expect((await treasuryTxs()).filter((t) => t.kind === 'topup')).toHaveLength(1);
  });

  it('accepts any amount from $1 up, unlike a spawn', async () => {
    const agent = await h.seedAgent({ ownerWallet: 'owner-wallet' });
    const topUp = await h.payments.topUp(agent.id, 'owner-wallet', usd(1), 'deposit');
    await pay(topUp.depositPubkey!, usd(1));
    await h.payments.pollNow();

    expect((await h.loadPurchase(topUp.id)).status).toBe('spawned');
    expect(usd(1)).toBeLessThan(MIN_PURCHASE_MICRO);
  });
});

describe('payments: wallet payments and the local simulator', () => {
  it('accepts a transaction that credited this deposit address and refuses one that did not', async () => {
    const { purchase } = await buy({ path: 'wallet', ownerWallet: 'BuyerPubkey111' });
    const other = await buy({ name: 'OTHER' });
    const wrong = await pay(other.purchase.depositPubkey!, usd(25));

    await expect(h.payments.attachPayment(purchase.id, wrong.sig)).rejects.toMatchObject({ code: 'INVALID_TX' });
    await expect(h.payments.attachPayment(purchase.id, 'simNotARealSignature')).rejects.toMatchObject({ code: 'INVALID_TX' });

    const paid = await pay(purchase.depositPubkey!, usd(25), 'BuyerPubkey111');
    const attached = await h.payments.attachPayment(purchase.id, paid.sig);
    expect(attached.status).toBe('spawned');
    expect(h.spawns[0]).toMatchObject({ ownerWallet: 'BuyerPubkey111', ownerKind: 'wallet' });
    expect((await h.loadPurchase(purchase.id)).refundTo).toBe('BuyerPubkey111');
  });

  it('simulate-pay completes a purchase inside one call, and only while it is pending', async () => {
    const { purchase } = await buy();
    const done = await h.payments.simulatePay(purchase.id);
    expect(done).toMatchObject({ status: 'spawned', receivedMicro: usd(25) });
    await expect(h.payments.simulatePay(purchase.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('simulate-pay can underpay, or pay in ETH', async () => {
    const under = await buy({ name: 'UNDER' });
    expect((await h.payments.simulatePay(under.purchase.id, usd(4)))).toMatchObject({ status: 'pending', receivedMicro: usd(4) });

    const eth = await buy({ name: 'ETHONLY' });
    const paid = await h.payments.simulatePay(eth.purchase.id, 0, 10_000_000);   // 0.01 ETH at $3000 = $30
    expect(paid).toMatchObject({ status: 'spawned', ethGweiReceived: 10_000_000 });
  });
});

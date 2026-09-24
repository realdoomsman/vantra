// Custodial wallets for Google owners (economy/custodial.ts): a keypair is minted once per Google
// identity, USDC deposited to it is readable as a balance, and a withdrawal moves it out to any
// address with the treasury paying gas. Guards: Google-only, valid destination, never over balance.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { googleOwnerId } from '@vantra/shared';
import { custodialWallet, ensureCustodialWallet, withdrawCustodial } from '../../src/economy/custodial.js';
import { userKeys, users } from '../../src/db/schema.js';
import { createHarness, type Harness } from './helpers/harness.js';

describe('economy/custodial', () => {
  let h: Harness;
  const googleId = googleOwnerId('sub-12345');

  beforeEach(async () => {
    h = await createHarness();
    const now = h.clock.now();
    await h.db.insert(users).values({ wallet: googleId, kind: 'google', createdAt: now, lastLoginAt: now });
  });
  afterEach(async () => { await h.close(); });

  it('mints one wallet per Google identity and is idempotent', async () => {
    const first = await ensureCustodialWallet(h.deps, googleId);
    const second = await ensureCustodialWallet(h.deps, googleId);
    expect(first).toBe(second);
    const [user] = await h.db.select().from(users).where(eq(users.wallet, googleId));
    expect(user!.custodialPubkey).toBe(first);
    const keys = await h.db.select().from(userKeys).where(eq(userKeys.ownerId, googleId));
    expect(keys).toHaveLength(1);
    expect(keys[0]!.pubkey).toBe(first);
  });

  it('refuses to mint one for a non-Google owner', async () => {
    await expect(ensureCustodialWallet(h.deps, 'Some111WalletOwnerAddress1111111111111111111')).rejects.toThrow();
  });

  it('reports the deposited USDC balance at the deposit address', async () => {
    const pubkey = await ensureCustodialWallet(h.deps, googleId);
    await h.fund(pubkey, 7_500_000);
    const w = await custodialWallet(h.deps, googleId);
    expect(w.pubkey).toBe(pubkey);
    expect(w.usdcMicro).toBe(7_500_000);
  });

  it('withdraws USDC to an external address and debits the wallet', async () => {
    const pubkey = await ensureCustodialWallet(h.deps, googleId);
    await h.fund(pubkey, 10_000_000);
    const dest = h.chain.newKeypair().pubkey;

    const res = await withdrawCustodial(h.deps, googleId, dest, 4_000_000);

    expect(res.sentMicro).toBe(4_000_000);
    expect(res.txSig).toBeTruthy();
    expect(await h.chain.getUsdcBalance(dest)).toBe(4_000_000);
    expect(await h.chain.getUsdcBalance(pubkey)).toBe(6_000_000);
  });

  it('refuses a withdrawal larger than the balance', async () => {
    const pubkey = await ensureCustodialWallet(h.deps, googleId);
    await h.fund(pubkey, 1_000_000);
    await expect(withdrawCustodial(h.deps, googleId, h.chain.newKeypair().pubkey, 2_000_000)).rejects.toThrow();
    // nothing moved
    expect(await h.chain.getUsdcBalance(pubkey)).toBe(1_000_000);
  });

  it('refuses a withdrawal to a non-EVM address', async () => {
    const pubkey = await ensureCustodialWallet(h.deps, googleId);
    await h.fund(pubkey, 1_000_000);
    await expect(withdrawCustodial(h.deps, googleId, 'not-a-real-address', 500_000)).rejects.toThrow();
  });
});

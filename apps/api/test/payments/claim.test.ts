// Claim codes (SPEC-V2 §5.5): the only credential on the no-wallet path. A code is 100 bits, it is
// stored only as an HMAC keyed with SESSION_SECRET, and every rejection looks identical from outside.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAIM_CODE_ALPHABET, CLAIM_CODE_RE, claimOwnerId, formatClaimCode, normalizeClaimCode, usd,
} from '@vantra/shared';
import { purchases, users } from '../../src/db/schema.js';
import { isApiError } from '../../src/lib/errors.js';
import { generateClaimCode, hashClaimCode, verifyClaimCode } from '../../src/payments/claim.js';
import { createPaymentsHarness, fundTreasury, type PaymentsHarness } from './helpers.js';

let h: PaymentsHarness;
const OTHER_SECRET = 'a-completely-different-session-secret-x';

afterEach(async () => { await h?.close(); });
beforeEach(async () => { h = await createPaymentsHarness(); });

const buy = (over: Record<string, unknown> = {}) =>
  h.payments.createPurchase({
    amountMicro: usd(25), name: 'TESTER', directive: 'Find someone who will pay for a thing.',
    path: 'deposit', ...over,
  });

const rejection = async (p: Promise<unknown>) => p.then(() => 'resolved', (e) => (isApiError(e) ? `${e.status} ${e.code}: ${e.message}` : String(e)));

describe('generateClaimCode', () => {
  it('draws 100 bits from the Crockford alphabet and prints them in groups of five', () => {
    const { code, normalized } = generateClaimCode();
    expect(normalized).toHaveLength(22);
    expect(normalized.startsWith('RW')).toBe(true);
    expect(CLAIM_CODE_RE.test(normalized)).toBe(true);
    expect([...normalized.slice(2)].every((c) => CLAIM_CODE_ALPHABET.includes(c))).toBe(true);
    expect(code).toBe(formatClaimCode(normalized));
    expect(code).toMatch(/^RW(-[0-9A-Z]{5}){4}$/);
    expect(normalizeClaimCode(code)).toBe(normalized);
  });

  it('never repeats over ten thousand draws, and uses the whole alphabet', () => {
    const seen = new Set<string>();
    const chars = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const { normalized } = generateClaimCode();
      seen.add(normalized);
      for (const c of normalized.slice(2)) chars.add(c);
    }
    expect(seen.size).toBe(10_000);
    expect(chars.size).toBe(CLAIM_CODE_ALPHABET.length);     // 32 symbols, all reachable
  });
});

describe('hashClaimCode', () => {
  it('is a keyed HMAC, not a bare digest: the secret is the pepper', () => {
    const { normalized } = generateClaimCode();
    const a = hashClaimCode(normalized, h.config.sessionSecret);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashClaimCode(normalized, h.config.sessionSecret)).toBe(a);        // deterministic
    expect(hashClaimCode(normalized, OTHER_SECRET)).not.toBe(a);              // keyed
    expect(a).not.toContain(normalized);
  });
});

describe('payments.claim', () => {
  it('mints the claim identity, and tolerates however the buyer typed the code', async () => {
    const { purchase, claimCode } = await buy();
    const ownerId = claimOwnerId(purchase.id);

    expect(await h.payments.claim(claimCode!)).toEqual({ ownerId });
    expect(await h.payments.claim(claimCode!.toLowerCase())).toEqual({ ownerId });
    expect(await h.payments.claim(claimCode!.replace(/-/g, ''))).toEqual({ ownerId });
    expect(await h.payments.claim(`  ${claimCode!.replace(/-/g, ' ')}  `)).toEqual({ ownerId });
  });

  it('works before the money has even landed, and creates the user row on the spot', async () => {
    const { purchase, claimCode } = await buy();
    expect((await h.loadPurchase(purchase.id)).status).toBe('pending');

    const { ownerId } = await h.payments.claim(claimCode!);
    const [user] = await h.db.select().from(users).where(eq(users.wallet, ownerId));
    expect(user).toMatchObject({ wallet: claimOwnerId(purchase.id), kind: 'claim', purchaseId: purchase.id });
  });

  it('keeps pointing at the same identity after the agent exists', async () => {
    await fundTreasury(h, usd(100));
    const { purchase, claimCode } = await buy();
    await h.payments.simulatePay(purchase.id);

    const { ownerId } = await h.payments.claim(claimCode!);
    expect(ownerId).toBe(claimOwnerId(purchase.id));
    expect(h.spawns[0]!.ownerWallet).toBe(ownerId);
    const [user] = await h.db.select().from(users).where(eq(users.wallet, ownerId));
    expect(user!.kind).toBe('claim');
  });

  it('answers every bad code the same way, so it is not an oracle', async () => {
    const { purchase, claimCode } = await buy();
    const expired = await buy({ name: 'GONER' });
    await h.db.update(purchases).set({ status: 'expired' }).where(eq(purchases.id, expired.purchase.id));

    const wrong = generateClaimCode().code;                 // well-formed, simply not ours
    const malformed = 'hello-there';
    const answers = await Promise.all([
      rejection(h.payments.claim(wrong)),
      rejection(h.payments.claim(malformed)),
      rejection(h.payments.claim(expired.claimCode!)),
      rejection(h.payments.claim('')),
    ]);
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toBe('401 INVALID_CLAIM_CODE: That claim code is not valid.');
    // and the real one still works
    expect(await h.payments.claim(claimCode!)).toEqual({ ownerId: claimOwnerId(purchase.id) });
  });

  it('is invalidated by rotating SESSION_SECRET, because the hash is peppered with it', async () => {
    const { claimCode } = await buy();
    expect(await verifyClaimCode(h.db, claimCode!, h.config.sessionSecret)).not.toBeNull();
    expect(await verifyClaimCode(h.db, claimCode!, OTHER_SECRET)).toBeNull();
  });

  it('refuses a refunded purchase, whose money has already gone back', async () => {
    const { purchase, claimCode } = await buy();
    await h.chain.faucet(purchase.depositPubkey!, usd(4), 'exchange-withdrawal');
    await h.payments.pollNow();
    h.clock.advanceHours(73);
    await h.payments.pollNow();

    expect((await h.loadPurchase(purchase.id)).status).toBe('refunded');
    expect(await rejection(h.payments.claim(claimCode!))).toBe('401 INVALID_CLAIM_CODE: That claim code is not valid.');
  });

  it('gives a wallet-path purchase no code to claim at all', async () => {
    const { claimCode } = await buy({ path: 'wallet', ownerWallet: 'BuyerPubkey111' });
    expect(claimCode).toBeNull();
    const [row] = await h.db.select().from(purchases);
    expect(row!.claimCodeHash).toBeNull();
  });
});

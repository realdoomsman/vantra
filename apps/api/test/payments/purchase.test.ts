// Creating, reading and cancelling a purchase (SPEC-V2 §5.2), plus top-ups (§5.10).
// The two invariants that matter most here: the claim code leaves the building exactly once, and a
// deposit secret never leaves it at all.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAIM_CODE_RE, DIRECTIVE_MAX_CHARS, normalizeClaimCode, tierById, usd } from '@vantra/shared';
import { purchases } from '../../src/db/schema.js';
import { hashClaimCode } from '../../src/payments/claim.js';
import { isApiError } from '../../src/lib/errors.js';
import { createPaymentsHarness, type PaymentsHarness } from './helpers.js';

let h: PaymentsHarness;

const buy = (over: Partial<Parameters<PaymentsHarness['payments']['createPurchase']>[0]> = {}) =>
  h.payments.createPurchase({
    amountMicro: usd(25), name: 'TESTER', directive: 'Find someone who will pay for a thing.',
    path: 'deposit', ...over,
  });

async function codeOf(e: unknown): Promise<string> {
  return isApiError(e) ? e.code : `not-an-api-error: ${String(e)}`;
}

afterEach(async () => { await h?.close(); });
beforeEach(async () => { h = await createPaymentsHarness(); });

describe('payments/createPurchase', () => {
  it('returns a deposit address, a claim code and the quote the buyer agreed to', async () => {
    const { purchase, claimCode } = await buy();

    expect(purchase).toMatchObject({
      kind: 'spawn', path: 'deposit', status: 'pending',
      quotedMicro: usd(25), receivedMicro: 0, feeMicro: usd(2.5), fundingMicro: usd(22.5), feeBps: 1000,
      quotedTierId: 'SCOUT', tierId: null, agentName: 'TESTER', agentId: null, topupAgentId: null,
      chainMode: 'memory', spawnError: null, ethGweiReceived: 0, ethValueMicro: 0,
    });
    expect(purchase.depositPubkey).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(purchase.quote.runwayDays).toBeGreaterThan(21);
    expect(new Date(purchase.expiresAt).getTime() - new Date(purchase.createdAt).getTime()).toBe(72 * 3_600_000);
    expect(claimCode).toMatch(/^RW(-[0-9A-Z]{5}){4}$/);
    expect(CLAIM_CODE_RE.test(normalizeClaimCode(claimCode!))).toBe(true);
  });

  it('gives the claim code out exactly once and stores only its HMAC', async () => {
    const { purchase, claimCode } = await buy();
    const normalized = normalizeClaimCode(claimCode!);
    const [row] = await h.db.select().from(purchases).where(eq(purchases.id, purchase.id));

    expect(row!.claimCodeHash).toBe(hashClaimCode(normalized, h.config.sessionSecret));
    expect(row!.claimCodeHash).not.toContain(normalized);
    // Nothing that is ever read back carries the code again.
    const again = await h.payments.getPurchase(purchase.id);
    const serialized = JSON.stringify([again, await h.payments.listPurchases(row!.ownerId!)]);
    expect(serialized).not.toContain(normalized);
    expect(serialized).not.toContain(claimCode);
    expect(serialized).not.toContain(row!.claimCodeHash);
  });

  it('never returns the deposit secret in any shape', async () => {
    const { purchase } = await buy();
    const [row] = await h.db.select().from(purchases).where(eq(purchases.id, purchase.id));
    expect(row!.depositSecretEnc).toBeInstanceOf(Buffer);        // encrypted at rest, and only at rest
    const serialized = JSON.stringify(await h.payments.getPurchase(purchase.id));
    for (const key of ['depositSecretEnc', 'depositIv', 'depositTag', 'secret', 'claimCode', 'ownerId']) {
      expect(serialized).not.toContain(key);
    }
    expect(serialized).not.toContain(row!.depositSecretEnc!.toString('base64'));
  });

  it('mints a different deposit address for every purchase', async () => {
    const a = await buy({ name: 'ALPHA' });
    const b = await buy({ name: 'BETA' });
    expect(a.purchase.depositPubkey).not.toBe(b.purchase.depositPubkey);
    expect(a.claimCode).not.toBe(b.claimCode);
  });

  it('derives the owner identity from the purchase id on the deposit path', async () => {
    const { purchase } = await buy();
    const [row] = await h.db.select().from(purchases).where(eq(purchases.id, purchase.id));
    expect(row!.ownerId).toBe(`claim_${purchase.id}`);
    expect(row!.ownerWallet).toBeNull();
    expect((await h.payments.listPurchases(row!.ownerId!)).map((p) => p.id)).toEqual([purchase.id]);
  });

  it('records the wallet buyer as the owner up front and gives them no claim code', async () => {
    const { purchase, claimCode } = await buy({ path: 'wallet', ownerWallet: 'BuyerPubkey111' });
    expect(claimCode).toBeNull();
    const [row] = await h.db.select().from(purchases).where(eq(purchases.id, purchase.id));
    expect(row).toMatchObject({ path: 'wallet', ownerWallet: 'BuyerPubkey111', ownerId: 'BuyerPubkey111', claimCodeHash: null });
  });

  it('refuses the wallet path without a session', async () => {
    await expect(buy({ path: 'wallet' }).catch(codeOf)).resolves.toBe('UNAUTHORIZED');
  });
});

describe('payments/createPurchase validation', () => {
  it('holds the purchase amount inside the configured band', async () => {
    await expect(buy({ amountMicro: usd(9.99) }).catch(codeOf)).resolves.toBe('BELOW_MINIMUM');
    await expect(buy({ amountMicro: usd(1001) }).catch(codeOf)).resolves.toBe('ABOVE_MAXIMUM');
    await expect(buy({ amountMicro: 10_000_000.5 }).catch(codeOf)).resolves.toBe('BAD_REQUEST');
  });

  it('refuses a projection below the minimum life, and says what it would have bought', async () => {
    await h.close();
    // A model so dear that even the top tier cannot clear 21 days at its own pace.
    h = await createPaymentsHarness({
      models: [{
        id: 'ruinous', provider: 'mock', label: 'Ruinous', tier: 'frontier',
        inputPerM: 400, outputPerM: 2000, contextK: 200, supportsEffort: true, thinking: 'none', enabled: true,
      }],
    });
    await expect(buy().catch((e) => (isApiError(e) ? [e.code, e.message] : e)))
      .resolves.toEqual(['BELOW_MINIMUM', expect.stringContaining('days of life')]);
  });

  // The dev override exists so a local tester can watch an agent think; gating on it would refuse
  // every purchase on the local runnable path (SPEC-V2 §10 buys a $25 SCOUT under `pnpm demo`).
  it('judges the minimum life at the tier pace even when HEARTBEAT_OVERRIDE_MIN is burning it down', async () => {
    await h.close();
    h = await createPaymentsHarness({ env: { HEARTBEAT_OVERRIDE_MIN: '5' } });
    const { purchase } = await buy();
    expect(purchase.status).toBe('pending');
    expect(purchase.quote.heartbeatMin).toBe(5);                  // the buyer is still told the truth
    expect(purchase.quote.runwayDays!).toBeLessThan(21);
  });

  it('validates the name and reserves it until the purchase closes', async () => {
    await expect(buy({ name: 'no' }).catch(codeOf)).resolves.toBe('BAD_REQUEST');
    await expect(buy({ name: 'VANTRA' }).catch(codeOf)).resolves.toBe('BAD_REQUEST');

    await buy({ name: 'ONLYONE' });
    await expect(buy({ name: 'ONLYONE' }).catch(codeOf)).resolves.toBe('NAME_TAKEN');
    await expect(buy({ name: 'onlyone' }).catch(codeOf)).resolves.toBe('NAME_TAKEN');   // names are uppercased first
  });

  // The read-then-insert above is a race two simultaneous buyers walk straight through; the partial
  // unique index is what actually settles it, and it must surface as the same 409.
  it('settles a simultaneous race for one name with a 409, not a 500', async () => {
    const results = await Promise.allSettled([
      buy({ name: 'RACER' }),
      buy({ name: 'RACER' }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(isApiError((lost[0] as PromiseRejectedResult).reason)).toBe(true);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: 'NAME_TAKEN' });
  });

  it('refuses a name an agent already has', async () => {
    await h.seedAgent({ name: 'INCUMBENT' });
    await expect(buy({ name: 'INCUMBENT' }).catch(codeOf)).resolves.toBe('NAME_TAKEN');
  });

  it('answers the availability question the Buy page asks', async () => {
    await h.seedAgent({ name: 'INCUMBENT' });
    await buy({ name: 'RESERVED' });
    expect(await h.payments.nameAvailable('fresh-one')).toEqual({ name: 'FRESH-ONE', available: true, reason: null });
    expect(await h.payments.nameAvailable('INCUMBENT')).toMatchObject({ available: false, reason: '"INCUMBENT" is taken' });
    expect(await h.payments.nameAvailable('RESERVED')).toMatchObject({ available: false, reason: expect.stringContaining('reserved') });
    expect(await h.payments.nameAvailable('!!')).toMatchObject({ available: false, reason: expect.stringContaining('3–16 characters') });
  });

  it('validates the directive', async () => {
    await expect(buy({ directive: '   ' }).catch(codeOf)).resolves.toBe('BAD_REQUEST');
    await expect(buy({ directive: 'x'.repeat(DIRECTIVE_MAX_CHARS + 1) }).catch(codeOf)).resolves.toBe('BAD_REQUEST');
  });

  it('defaults the tools to the tier and names the tier that unlocks anything above it', async () => {
    const { purchase } = await buy();
    expect(purchase.quote.enabledTools).toEqual(tierById('SCOUT')!.enabledTools);

    const [row] = await h.db.select().from(purchases).where(eq(purchases.id, purchase.id));
    expect(row!.tools).toEqual(tierById('SCOUT')!.enabledTools);

    await expect(buy({ name: 'TOOLY', tools: ['bash'] }).catch((e) => (isApiError(e) ? e.message : e)))
      .resolves.toMatch(/"bash" is not available at SCOUT; it unlocks at OPERATOR/);
    await expect(buy({ name: 'TOOLY', tools: ['nope'] as never }).catch(codeOf)).resolves.toBe('BAD_REQUEST');
    await expect(buy({ name: 'TOOLY', tools: [] }).catch(codeOf)).resolves.toBe('BAD_REQUEST');
  });

  it('keeps a subset the buyer asked for', async () => {
    const { purchase } = await buy({ tools: ['fetch_url', 'wallet', 'fetch_url'] });
    const [row] = await h.db.select().from(purchases).where(eq(purchases.id, purchase.id));
    expect(row!.tools).toEqual(['fetch_url', 'wallet']);
  });

  it('refuses an unknown pace and an unknown fork parent', async () => {
    await expect(buy({ pace: 'frantic' as never }).catch(codeOf)).resolves.toBe('BAD_REQUEST');
    await expect(buy({ forkOf: 'ag_doesnotexi' }).catch(codeOf)).resolves.toBe('NOT_FOUND');
  });
});

describe('payments/cancelPurchase', () => {
  it('lets the buyer cancel while nothing has arrived, and nobody else', async () => {
    const { purchase } = await buy();
    const ownerId = `claim_${purchase.id}`;
    await expect(h.payments.cancelPurchase(purchase.id, 'someone-else').catch(codeOf)).resolves.toBe('FORBIDDEN');

    const cancelled = await h.payments.cancelPurchase(purchase.id, ownerId);
    expect(cancelled.status).toBe('expired');
    expect(cancelled.depositPubkey).toBeNull();          // the secret was wiped with the row
    const row = await h.loadPurchase(purchase.id);
    expect(row.depositSecretEnc).toBeNull();
  });

  it('refuses to cancel a purchase that is already paid for', async () => {
    const { purchase } = await buy();
    await h.payments.simulatePay(purchase.id);
    await expect(h.payments.cancelPurchase(purchase.id, `claim_${purchase.id}`).catch(codeOf)).resolves.toBe('CONFLICT');
  });
});

describe('payments/topUp', () => {
  it('opens a second deposit address for an agent that already exists', async () => {
    const agent = await h.seedAgent({ name: 'INCUMBENT', ownerWallet: 'owner-wallet' });
    const topUp = await h.payments.topUp(agent.id, 'owner-wallet', usd(5), 'deposit');

    expect(topUp).toMatchObject({
      kind: 'topup', status: 'pending', quotedMicro: usd(5), topupAgentId: agent.id, agentName: null,
      quotedTierId: 'SPARK',
    });
    expect(topUp.depositPubkey).toBeTruthy();
    const row = await h.loadPurchase(topUp.id);
    expect(row).toMatchObject({ claimCodeHash: null, ownerId: 'owner-wallet', feeBps: 1000 });
  });

  it('is owner-only, refuses the dead, and keeps the $1 floor', async () => {
    const agent = await h.seedAgent({ ownerWallet: 'owner-wallet' });
    await expect(h.payments.topUp(agent.id, 'someone-else', usd(5), 'deposit').catch(codeOf)).resolves.toBe('FORBIDDEN');
    await expect(h.payments.topUp(agent.id, 'owner-wallet', usd(0.5), 'deposit').catch(codeOf)).resolves.toBe('BELOW_MINIMUM');
    await expect(h.payments.topUp('ag_nope000000', 'owner-wallet', usd(5), 'deposit').catch(codeOf)).resolves.toBe('NOT_FOUND');

    const dead = await h.seedAgent({ name: 'GONER', ownerWallet: 'owner-wallet', status: 'dead' });
    await expect(h.payments.topUp(dead.id, 'owner-wallet', usd(5), 'deposit').catch(codeOf)).resolves.toBe('NOT_ELIGIBLE');
  });

  it('shows up in the owner open-purchase list next to their spawns', async () => {
    const agent = await h.seedAgent({ ownerWallet: 'owner-wallet' });
    const topUp = await h.payments.topUp(agent.id, 'owner-wallet', usd(5), 'deposit');
    expect((await h.payments.listPurchases('owner-wallet')).map((p) => p.id)).toEqual([topUp.id]);
  });
});

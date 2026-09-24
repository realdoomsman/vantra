import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, Me } from '@vantra/shared';
import { buildSignInMessage, parseSignInMessage, verifyWalletSignature } from '../../src/http/auth.js';
import { buildTestApp, cookieHeader, json, PROD_ENV, web, type TestApp } from './helpers/app.js';
import { purchaseOfClaimOwnerId } from '@vantra/shared';
import { CLAIM_CODE, CLAIM_OWNER, PAYOUT_WALLET, PURCHASE_ID } from './helpers/fixtures.js';

const account = privateKeyToAccount(generatePrivateKey());
const wallet = account.address;
// personal_sign over the message text; the server recovers the signer from it.
const sign = (message: string, signer = account): Promise<string> => signer.signMessage({ message });

let t: TestApp;
afterEach(async () => { await t?.close(); });

async function nonce(app: TestApp['app'], w: string = wallet): Promise<string> {
  const res = await app.inject({ method: 'GET', url: `/api/auth/nonce?wallet=${w}` });
  expect(res.statusCode).toBe(200);
  return json<{ message: string }>(res).message;
}

describe('sign-in message helpers', () => {
  it('round-trips the exact message format', () => {
    const issued = new Date('2026-09-16T12:00:00.000Z');
    const message = buildSignInMessage(wallet, 'abcdefghijklmnopqrstuvwx', issued);
    expect(message).toBe(`VANTRA wants you to sign in.\nWallet: ${wallet}\nNonce: abcdefghijklmnopqrstuvwx\nIssued: 2026-09-16T12:00:00.000Z\nThis signature does not send a transaction.`);
    expect(parseSignInMessage(message)).toEqual({ wallet, nonce: 'abcdefghijklmnopqrstuvwx', issued: '2026-09-16T12:00:00.000Z' });
    expect(parseSignInMessage(`${message}\nextra`)).toBeNull();
  });

  it('verifies personal_sign signatures and rejects malformed input', async () => {
    const message = 'hello';
    const stranger = privateKeyToAccount(generatePrivateKey());
    expect(await verifyWalletSignature(message, await sign(message), wallet)).toBe(true);
    expect(await verifyWalletSignature('tampered', await sign(message), wallet)).toBe(false);
    expect(await verifyWalletSignature(message, await sign(message, stranger), wallet)).toBe(false);
    expect(await verifyWalletSignature(message, 'not-hex!', wallet)).toBe(false);
    // A well-formed signature from the right signer still fails against a malformed address.
    expect(await verifyWalletSignature(message, await sign(message), 'short')).toBe(false);
    // Casing is not identity: the same address in lower case verifies just as well.
    expect(await verifyWalletSignature(message, await sign(message), wallet.toLowerCase())).toBe(true);
  });
});

describe('sign-in flow', () => {
  it('nonce → sign → verify → cookie → /api/me', async () => {
    t = await buildTestApp();
    const message = await nonce(t.app);
    expect(message.startsWith('VANTRA wants you to sign in.\nWallet: ')).toBe(true);

    const verify = await t.app.inject(web({ method: 'POST', url: '/api/auth/verify', payload: { wallet, signature: await sign(message), message } }));
    expect(verify.statusCode).toBe(200);
    expect(json<Me>(verify).wallet).toBe(wallet);
    const setCookie = String(verify.headers['set-cookie']);
    expect(setCookie).toMatch(/^rw_session=/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Secure');
    expect(t.store.users.get(wallet)).toMatchObject({ kind: 'wallet', purchaseId: null });

    const me = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieHeader(verify) } });
    expect(me.statusCode).toBe(200);
    expect(json<Me>(me).wallet).toBe(wallet);

    const anonymous = await t.app.inject({ method: 'GET', url: '/api/me' });
    expect(anonymous.statusCode).toBe(401);
    expect(json<ApiErrorBody>(anonymous).error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a reused nonce', async () => {
    t = await buildTestApp();
    const message = await nonce(t.app);
    const payload = { wallet, signature: await sign(message), message };
    expect((await t.app.inject(web({ method: 'POST', url: '/api/auth/verify', payload }))).statusCode).toBe(200);
    const again = await t.app.inject(web({ method: 'POST', url: '/api/auth/verify', payload }));
    expect(again.statusCode).toBe(401);
    expect(json<ApiErrorBody>(again).error.code).toBe('INVALID_SIGNATURE');
  });

  it('rejects the wrong signer, a tampered message and a foreign wallet', async () => {
    t = await buildTestApp();
    const message = await nonce(t.app);
    const stranger = privateKeyToAccount(generatePrivateKey());
    const wrongSigner = await t.app.inject(web({ method: 'POST', url: '/api/auth/verify', payload: { wallet, signature: await sign(message, stranger), message } }));
    expect(wrongSigner.statusCode).toBe(401);

    const tampered = message.replace('does not send', 'sends');
    const tamperedRes = await t.app.inject(web({ method: 'POST', url: '/api/auth/verify', payload: { wallet, signature: await sign(tampered), message: tampered } }));
    expect(tamperedRes.statusCode).toBe(401);

    // A real signature by a real account, over a message that names somebody else's wallet.
    const foreign = await t.app.inject(web({ method: 'POST', url: '/api/auth/verify', payload: { wallet: stranger.address, signature: await sign(message, stranger), message } }));
    expect(foreign.statusCode).toBe(401);
    expect(t.store.nonces.has(wallet)).toBe(true);   // failed attempts do not burn the nonce
  });

  it('rejects an expired nonce', async () => {
    t = await buildTestApp();
    const message = await nonce(t.app);
    t.store.nonces.get(wallet)!.expiresAt = new Date(Date.now() - 1);
    const res = await t.app.inject(web({ method: 'POST', url: '/api/auth/verify', payload: { wallet, signature: await sign(message), message } }));
    expect(res.statusCode).toBe(401);
  });

  it('validates the wallet address', async () => {
    t = await buildTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/nonce?wallet=not-an-address' });
    expect(res.statusCode).toBe(400);
    expect(json<ApiErrorBody>(res).error.code).toBe('BAD_REQUEST');
  });

  // EIP-55 casing is presentation, not identity: a wallet that reports its address in lower case
  // must get the session its checksummed spelling would have got, under one owner id.
  it('accepts a lower-case address and stores it checksummed', async () => {
    t = await buildTestApp();
    const lower = wallet.toLowerCase();
    const message = await nonce(t.app, lower);
    expect(message).toContain(`Wallet: ${wallet}`);
    const verify = await t.app.inject(web({ method: 'POST', url: '/api/auth/verify', payload: { wallet: lower, signature: await sign(message), message } }));
    expect(verify.statusCode).toBe(200);
    expect(json<Me>(verify).wallet).toBe(wallet);
    expect(t.store.users.has(wallet)).toBe(true);
    expect(t.store.users.has(lower)).toBe(false);
  });

  it('logout clears the cookie and invalidates the session', async () => {
    t = await buildTestApp();
    const cookie = await t.signIn('demo-wallet-9');
    const out = await t.app.inject(web({ method: 'POST', url: '/api/auth/logout', headers: { cookie } }));
    expect(out.statusCode).toBe(200);
    expect(json(out)).toEqual({ ok: true });
    expect(String(out.headers['set-cookie'])).toMatch(/^rw_session=;/);
    expect(t.store.sessions.size).toBe(0);
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('marks the session cookie Secure in production', async () => {
    t = await buildTestApp({ env: PROD_ENV });
    const message = await nonce(t.app);
    const verify = await t.app.inject(web({ method: 'POST', url: '/api/auth/verify', payload: { wallet, signature: await sign(message), message } }));
    expect(verify.statusCode).toBe(200);
    const setCookie = String(verify.headers['set-cookie']);
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
  });

  it('ignores a cookie whose signature does not match', async () => {
    t = await buildTestApp();
    const cookie = await t.signIn('demo-wallet-9');
    const forged = cookie.replace(/\.[^.]+$/, '.forged');
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: forged } })).statusCode).toBe(401);
  });
});

// SPEC-V2 §6.1: the claim code is the second credential, and it mints the SAME cookie.
describe('claim-code sign-in', () => {
  it('derives the owner kind and the purchase behind a claim session', () => {
    expect(purchaseOfClaimOwnerId(CLAIM_OWNER)).toBe(PURCHASE_ID);
    expect(purchaseOfClaimOwnerId(wallet)).toBeNull();
  });

  it('produces a session indistinguishable from a wallet session', async () => {
    t = await buildTestApp();
    const claimed = await t.app.inject(web({ method: 'POST', url: '/api/claim', payload: { code: CLAIM_CODE } }));
    expect(claimed.statusCode).toBe(200);
    const setCookie = String(claimed.headers['set-cookie']);
    expect(setCookie).toMatch(/^rw_session=/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(t.store.users.get(CLAIM_OWNER)).toMatchObject({ kind: 'claim', purchaseId: PURCHASE_ID });

    const cookie = cookieHeader(claimed);
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);

    // And it signs out through exactly the same route.
    await t.app.inject(web({ method: 'POST', url: '/api/auth/logout', headers: { cookie } }));
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('demo sign-in', () => {
  it('exists only when DEMO=1', async () => {
    t = await buildTestApp({ env: { DEMO: '0' } });
    const res = await t.app.inject(web({ method: 'POST', url: '/api/auth/demo', payload: { wallet: 'demo-wallet-1' } }));
    expect(res.statusCode).toBe(404);
    await t.close();

    t = await buildTestApp({ env: { DEMO: '1' } });
    const ok = await t.app.inject(web({ method: 'POST', url: '/api/auth/demo', payload: { wallet: 'demo-wallet-1' } }));
    expect(ok.statusCode).toBe(200);
    expect(json<Me>(ok).wallet).toBe('demo-wallet-1');
    expect(String(ok.headers['set-cookie'])).toMatch(/^rw_session=/);
  });
});

describe('rate limit', () => {
  it('allows 20 nonce requests per minute per IP, then 429s with the error envelope', async () => {
    t = await buildTestApp();
    for (let i = 0; i < 20; i++) {
      expect((await t.app.inject({ method: 'GET', url: `/api/auth/nonce?wallet=${wallet}` })).statusCode).toBe(200);
    }
    const blocked = await t.app.inject({ method: 'GET', url: `/api/auth/nonce?wallet=${wallet}` });
    expect(blocked.statusCode).toBe(429);
    expect(json<ApiErrorBody>(blocked).error.code).toBe('RATE_LIMITED');
    // Other IPs and other routes are unaffected.
    expect((await t.app.inject({ method: 'GET', url: `/api/auth/nonce?wallet=${wallet}`, remoteAddress: '10.0.0.7' })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });

  // The per-session limiter (sessionRateKey) still works after the owner-id rename: two different
  // sessions behind one IP each get their own budget.
  it('limits /api/me/payout-wallet to 10 per minute per session', async () => {
    t = await buildTestApp();
    const cookie = await t.signIn('demo-wallet-1');
    const other = await t.signIn('demo-wallet-2');
    const payload = { wallet: PAYOUT_WALLET };
    for (let i = 0; i < 10; i++) {
      expect((await t.app.inject(web({ method: 'POST', url: '/api/me/payout-wallet', payload, headers: { cookie } }))).statusCode).toBe(200);
    }
    expect((await t.app.inject(web({ method: 'POST', url: '/api/me/payout-wallet', payload, headers: { cookie } }))).statusCode).toBe(429);
    expect((await t.app.inject(web({ method: 'POST', url: '/api/me/payout-wallet', payload, headers: { cookie: other } }))).statusCode).toBe(200);
    expect(t.services.callsTo('setPayoutWallet')).toHaveLength(11);
  });
});

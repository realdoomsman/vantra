// Buying an agent over HTTP (SPEC-V2 §8.2): tiers, quote, name check, purchase, claim.
// The two things this file exists to prove: the plaintext claim code is returned exactly once, and
// nothing that could impersonate a buyer — the code, the deposit secret, the owner id — ever leaves
// through a purchase payload.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PURCHASE_MICRO, MIN_PURCHASE_MICRO, claimOwnerId, normalizeClaimCode,
  type ApiErrorBody, type CreatePurchaseResponse, type Me, type NameAvailableResponse,
  type PurchasePublic, type QuoteResponse, type TiersResponse, type TopUpResponse,
} from '@vantra/shared';
import { buildTestApp, cookieHeader, json, web, type TestApp } from './helpers/app.js';
import { AGENT_A, CLAIM_CODE, CLAIM_OWNER, OWNER_A, PURCHASE_ID } from './helpers/fixtures.js';

let t: TestApp;
let ownerA: string;

const BUY = {
  amountMicro: 25_000_000,
  name: 'GAMMA',
  directive: 'Sell tiny APIs to people who need them',
  pace: 'steady' as const,
};

// A fresh app per test: several of these assertions are about per-IP and per-session rate limits,
// which a shared instance would leak between cases.
beforeEach(async () => {
  t = await buildTestApp();
  ownerA = await t.signIn(OWNER_A);
});
afterEach(async () => { await t?.close(); });

describe('GET /api/tiers', () => {
  it('is public and carries the fee, the bounds and a resolved model per tier', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/tiers' });
    expect(res.statusCode).toBe(200);
    const body = json<TiersResponse>(res);
    expect(body.tiers.map((x) => x.id)).toEqual(['SPARK', 'SCOUT', 'OPERATOR', 'PRIME']);
    expect(body.minMicro).toBe(MIN_PURCHASE_MICRO);
    expect(body.maxMicro).toBe(MAX_PURCHASE_MICRO);
    expect(body.tiers.every((x) => x.stepCostMicro > 0 && x.modelLabel.length > 0)).toBe(true);
  });
});

describe('POST /api/quote', () => {
  it('quotes without a session and passes the pace through', async () => {
    const res = await t.app.inject(web({ method: 'POST', url: '/api/quote', payload: { amountMicro: 25_000_000, pace: 'patient' } }));
    expect(res.statusCode).toBe(200);
    const q = json<QuoteResponse>(res);
    expect(q.feeMicro + q.fundingMicro).toBe(q.amountMicro);
    expect(q.tierId).toBe('SCOUT');
    expect(t.payments.callsTo('quote').at(-1)!.args).toEqual([25_000_000, 'patient']);
  });

  it('rejects a non-integer amount and an unknown pace', async () => {
    for (const payload of [{ amountMicro: 1.5 }, { amountMicro: 0 }, { amountMicro: 10_000_000, pace: 'frantic' }, {}]) {
      const res = await t.app.inject(web({ method: 'POST', url: '/api/quote', payload }));
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(json<ApiErrorBody>(res).error.code).toBe('BAD_REQUEST');
    }
  });
});

describe('GET /api/purchases/name-available', () => {
  it('answers without a session', async () => {
    const free = await t.app.inject({ method: 'GET', url: '/api/purchases/name-available?name=gamma' });
    expect(json<NameAvailableResponse>(free)).toEqual({ name: 'GAMMA', available: true, reason: null });

    const taken = await t.app.inject({ method: 'GET', url: '/api/purchases/name-available?name=alpha' });
    expect(json<NameAvailableResponse>(taken).available).toBe(false);

    expect((await t.app.inject({ method: 'GET', url: '/api/purchases/name-available' })).statusCode).toBe(400);
  });
});

describe('POST /api/purchases', () => {
  it('creates a deposit purchase with no session and returns the claim code once', async () => {
    const res = await t.app.inject(web({ method: 'POST', url: '/api/purchases', payload: BUY }));
    expect(res.statusCode).toBe(201);
    const body = json<CreatePurchaseResponse>(res);
    expect(body.claimCode).toBe(CLAIM_CODE);
    expect(body.purchase.depositPubkey).toBeTruthy();
    expect(body.purchase.quotedMicro).toBe(BUY.amountMicro);
    expect(t.payments.callsTo('createPurchase').at(-1)!.args[0]).toMatchObject({
      amountMicro: BUY.amountMicro, name: 'GAMMA', path: 'deposit', pace: 'steady', ownerWallet: undefined,
    });

    // Every later read of the same purchase is code-free.
    const again = await t.app.inject({ method: 'GET', url: `/api/purchases/${body.purchase.id}` });
    expect(again.statusCode).toBe(200);
    expect(again.body).not.toContain('LEAK');
    expect(again.body).not.toContain('claimCode');
  });

  it('defaults path to deposit and tools to the tier default', async () => {
    const res = await t.app.inject(web({ method: 'POST', url: '/api/purchases', payload: { amountMicro: 10_000_000, name: 'DELTA2', directive: 'Do a thing' } }));
    expect(res.statusCode).toBe(201);
    const input = t.payments.callsTo('createPurchase').at(-1)!.args[0] as Record<string, unknown>;
    expect(input.path).toBe('deposit');
    expect(input.tools).toBeUndefined();
    expect(input.pace).toBeUndefined();
  });

  it('rejects a bad body before it reaches Payments', async () => {
    const before = t.payments.calls.length;
    const cases: Record<string, unknown>[] = [
      { ...BUY, amountMicro: 0 },
      { ...BUY, amountMicro: 10.5 },
      { ...BUY, name: '' },
      { ...BUY, directive: '' },
      { ...BUY, directive: 'x'.repeat(601) },
      { ...BUY, tools: ['rm_rf'] },
      { ...BUY, pace: 'frantic' },
      { ...BUY, path: 'card' },
    ];
    for (const payload of cases) {
      const res = await t.app.inject(web({ method: 'POST', url: '/api/purchases', payload }));
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(t.payments.calls.length).toBe(before);
  });

  it('surfaces a BELOW_MINIMUM from Payments with its code', async () => {
    const res = await t.app.inject(web({ method: 'POST', url: '/api/purchases', payload: { ...BUY, amountMicro: 5_000_000 } }));
    expect(res.statusCode).toBe(400);
    expect(json<ApiErrorBody>(res).error.code).toBe('BELOW_MINIMUM');
  });

  describe('the wallet path', () => {
    it('401s signed out, 400s a claim session, and passes the pubkey when a wallet signs in', async () => {
      const anon = await t.app.inject(web({ method: 'POST', url: '/api/purchases', payload: { ...BUY, path: 'wallet' } }));
      expect(anon.statusCode).toBe(401);

      const claimCookie = await t.signIn(CLAIM_OWNER);
      const claimed = await t.app.inject(web({ method: 'POST', url: '/api/purchases', payload: { ...BUY, path: 'wallet' }, headers: { cookie: claimCookie } }));
      expect(claimed.statusCode).toBe(400);
      expect(json<ApiErrorBody>(claimed).error.message).toMatch(/no wallet to pay from/i);

      const ok = await t.app.inject(web({ method: 'POST', url: '/api/purchases', payload: { ...BUY, path: 'wallet' }, headers: { cookie: ownerA } }));
      expect(ok.statusCode).toBe(201);
      expect(json<CreatePurchaseResponse>(ok).claimCode).toBeNull();
      expect(t.payments.callsTo('createPurchase').at(-1)!.args[0]).toMatchObject({ path: 'wallet', ownerWallet: OWNER_A });
    });
  });
});

describe('GET /api/purchases/:id', () => {
  it('is public and never carries the claim code, the deposit secret or the owner id', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/purchases/${PURCHASE_ID}` });
    expect(res.statusCode).toBe(200);
    const body = json<PurchasePublic>(res);
    expect(body.id).toBe(PURCHASE_ID);
    expect(body.depositPubkey).toBeTruthy();

    // The fake hands the route a row that DOES carry all three (helpers/fakePayments.ts:leaky).
    for (const key of ['claimCode', 'ownerId', 'depositSecretEnc']) {
      expect(Object.keys(body), key).not.toContain(key);
    }
    expect(res.body).not.toContain('deadbeef');
    expect(res.body).not.toContain(claimOwnerId(PURCHASE_ID));
  });

  it('404s an unknown id', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/purchases/pu_nosuchxxxx' });
    expect(res.statusCode).toBe(404);
    expect(json<ApiErrorBody>(res).error.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/purchases/:id/attach and /cancel', () => {
  it('attach is public and needs a signature', async () => {
    const ok = await t.app.inject(web({ method: 'POST', url: `/api/purchases/${PURCHASE_ID}/attach`, payload: { txSig: 'sig-1' } }));
    expect(ok.statusCode).toBe(200);
    expect(json<PurchasePublic>(ok).status).toBe('received');
    expect(t.payments.callsTo('attachPayment').at(-1)!.args).toEqual([PURCHASE_ID, 'sig-1']);

    expect((await t.app.inject(web({ method: 'POST', url: `/api/purchases/${PURCHASE_ID}/attach`, payload: {} }))).statusCode).toBe(400);
  });

  it('cancel requires a session and passes the caller as the owner', async () => {
    const anon = await t.app.inject(web({ method: 'POST', url: `/api/purchases/${PURCHASE_ID}/cancel` }));
    expect(anon.statusCode).toBe(401);

    const ok = await t.app.inject(web({ method: 'POST', url: `/api/purchases/${PURCHASE_ID}/cancel`, headers: { cookie: ownerA } }));
    expect(ok.statusCode).toBe(200);
    expect(t.payments.callsTo('cancelPurchase').at(-1)!.args).toEqual([PURCHASE_ID, OWNER_A]);
  });
});

describe('POST /api/claim', () => {
  it('mints the same rw_session a wallet gets and returns Me for the claim identity', async () => {
    const res = await t.app.inject(web({ method: 'POST', url: '/api/claim', payload: { code: CLAIM_CODE } }));
    expect(res.statusCode).toBe(200);
    const me = json<Me>(res);
    expect(me.ownerId).toBe(CLAIM_OWNER);
    expect(me.ownerKind).toBe('claim');
    expect(me.wallet).toBeNull();

    const cookie = cookieHeader(res);
    expect(String(res.headers['set-cookie'])).toMatch(/^rw_session=/);
    expect(t.store.users.get(CLAIM_OWNER)).toMatchObject({ kind: 'claim', purchaseId: PURCHASE_ID });

    // The cookie is a real session: it reaches an authenticated route.
    const meAgain = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(meAgain.statusCode).toBe(200);
    expect(json<Me>(meAgain).ownerId).toBe(CLAIM_OWNER);
  });

  it('accepts a lower-case, un-dashed code', async () => {
    const res = await t.app.inject(web({ method: 'POST', url: '/api/claim', payload: { code: normalizeClaimCode(CLAIM_CODE).toLowerCase() } }));
    expect(res.statusCode).toBe(200);
  });

  it('401s a wrong code with no session and no oracle', async () => {
    const res = await t.app.inject(web({ method: 'POST', url: '/api/claim', payload: { code: 'RW-00000-00000-00000-00000' } }));
    expect(res.statusCode).toBe(401);
    expect(json<ApiErrorBody>(res).error).toEqual({ code: 'INVALID_CLAIM_CODE', message: 'That claim code is not valid.' });
    expect(res.headers['set-cookie']).toBeUndefined();

    expect((await t.app.inject(web({ method: 'POST', url: '/api/claim', payload: { code: 'xx' } }))).statusCode).toBe(400);
  });
});

describe('POST /api/agents/:id/topup', () => {
  it('needs the owner and returns a fresh purchase for the agent', async () => {
    const anon = await t.app.inject(web({ method: 'POST', url: `/api/agents/${AGENT_A}/topup`, payload: { amountMicro: 5_000_000 } }));
    expect(anon.statusCode).toBe(401);

    const res = await t.app.inject(web({ method: 'POST', url: `/api/agents/${AGENT_A}/topup`, payload: { amountMicro: 5_000_000 }, headers: { cookie: ownerA } }));
    expect(res.statusCode).toBe(200);
    const { purchase } = json<TopUpResponse>(res);
    expect(purchase.kind).toBe('topup');
    expect(purchase.topupAgentId).toBe(AGENT_A);
    expect(t.payments.callsTo('topUp').at(-1)!.args).toEqual([AGENT_A, OWNER_A, 5_000_000, 'deposit']);
    expect(Object.keys(purchase)).not.toContain('claimCode');
  });
});

describe('every mutating purchase route needs the CSRF header', () => {
  it('403s without x-vantra-client', async () => {
    const routes: [string, Record<string, unknown>][] = [
      ['/api/quote', { amountMicro: 10_000_000 }],
      ['/api/purchases', BUY],
      [`/api/purchases/${PURCHASE_ID}/attach`, { txSig: 'sig-1' }],
      [`/api/purchases/${PURCHASE_ID}/cancel`, {}],
      [`/api/purchases/${PURCHASE_ID}/simulate-pay`, {}],
      ['/api/claim', { code: CLAIM_CODE }],
      [`/api/agents/${AGENT_A}/topup`, { amountMicro: 5_000_000 }],
    ];
    for (const [url, payload] of routes) {
      const res = await t.app.inject({ method: 'POST', url, payload, headers: { cookie: ownerA } });
      expect(res.statusCode, url).toBe(403);
      expect(json<ApiErrorBody>(res).error.code).toBe('FORBIDDEN');
    }
  });
});

describe('POST /api/purchases/:id/simulate-pay', () => {
  let onchain: TestApp;
  afterEach(async () => { await onchain?.close(); });

  it('exists on the memory chain and fulfils the purchase in-request', async () => {
    const res = await t.app.inject(web({ method: 'POST', url: `/api/purchases/${PURCHASE_ID}/simulate-pay`, payload: {} }));
    expect(res.statusCode).toBe(200);
    expect(json<PurchasePublic>(res).status).toBe('spawned');
    expect(t.payments.callsTo('simulatePay').at(-1)!.args).toEqual([PURCHASE_ID, undefined, undefined]);

    const partial = await t.app.inject(web({ method: 'POST', url: `/api/purchases/${PURCHASE_ID}/simulate-pay`, payload: { amountMicro: 4_000_000, ethGwei: 20_000_000 } }));
    expect(partial.statusCode).toBe(200);
    expect(t.payments.callsTo('simulatePay').at(-1)!.args).toEqual([PURCHASE_ID, 4_000_000, 20_000_000]);
  });

  it('is not mounted at all when the chain is not memory', async () => {
    onchain = await buildTestApp({ chainMode: 'robinhood' });
    const res = await onchain.app.inject(web({ method: 'POST', url: `/api/purchases/${PURCHASE_ID}/simulate-pay`, payload: {} }));
    expect(res.statusCode).toBe(404);
    expect(onchain.payments.callsTo('simulatePay')).toHaveLength(0);

    // …and health says so, so the Pending page never renders a button that 404s.
    const health = json<{ payments: { mode: string; simulateEnabled: boolean } }>(await onchain.app.inject({ method: 'GET', url: '/api/health' }));
    expect(health.payments).toEqual({ mode: 'robinhood', simulateEnabled: false });
  });
});

describe('rate limits', () => {
  it('caps purchase creation at 10/min/IP and claims at 10/min/IP', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await t.app.inject(web({ method: 'POST', url: '/api/purchases', payload: { ...BUY, name: `GAMMA${i}` } }));
      expect(res.statusCode, `attempt ${i}`).toBe(201);
    }
    const blocked = await t.app.inject(web({ method: 'POST', url: '/api/purchases', payload: BUY }));
    expect(blocked.statusCode).toBe(429);
    expect(json<ApiErrorBody>(blocked).error.code).toBe('RATE_LIMITED');
    // Another IP is unaffected, and the other purchase routes keep their own budgets.
    expect((await t.app.inject(web({ method: 'POST', url: '/api/purchases', payload: BUY, remoteAddress: '10.0.0.7' }))).statusCode).toBe(201);

    for (let i = 0; i < 10; i++) {
      expect((await t.app.inject(web({ method: 'POST', url: '/api/claim', payload: { code: CLAIM_CODE } }))).statusCode).toBe(200);
    }
    expect((await t.app.inject(web({ method: 'POST', url: '/api/claim', payload: { code: CLAIM_CODE } }))).statusCode).toBe(429);
  });

  it('caps top-ups at 10/min/session', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await t.app.inject(web({ method: 'POST', url: `/api/agents/${AGENT_A}/topup`, payload: { amountMicro: 2_000_000 }, headers: { cookie: ownerA } }))).statusCode).toBe(200);
    }
    expect((await t.app.inject(web({ method: 'POST', url: `/api/agents/${AGENT_A}/topup`, payload: { amountMicro: 2_000_000 }, headers: { cookie: ownerA } }))).statusCode).toBe(429);
    expect(t.payments.callsTo('topUp')).toHaveLength(10);
  });
});

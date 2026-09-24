// Observatory reads (stats/series/events/leaderboard/models/treasury) and the market routes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ApiErrorBody, Bounty, CallServiceResponse, GlobalStats, HealthResponse, Me, ModelInfo, Service,
  TreasuryPublic, TreasuryTx,
} from '@vantra/shared';
import { buildTestApp, json, web, type TestApp } from './helpers/app.js';
import { AGENT_A, CLAIM_OWNER, OWNER_A, OWNER_B, PAYOUT_WALLET, makeStats } from './helpers/fixtures.js';

let t: TestApp;
let ownerA: string;
let ownerB: string;

beforeAll(async () => {
  t = await buildTestApp();
  ownerA = await t.signIn(OWNER_A);
  ownerB = await t.signIn(OWNER_B);
});
afterAll(async () => { await t.close(); });

// The v2 route table (SPEC-V2 §8.1) in one place: what must exist, and what must not. E codes its
// client against these exact paths.
const V2_ROUTES: [string, string][] = [
  ['GET', '/api/health'], ['GET', '/api/stats'], ['GET', '/api/stats/series'], ['GET', '/api/events'],
  ['GET', '/api/leaderboard'], ['GET', '/api/models'], ['GET', '/api/graveyard'],
  ['GET', '/api/tiers'], ['POST', '/api/quote'], ['POST', '/api/claim'],
  ['GET', '/api/purchases/name-available'], ['POST', '/api/purchases'], ['GET', '/api/purchases/:id'],
  ['POST', '/api/purchases/:id/attach'], ['POST', '/api/purchases/:id/cancel'], ['POST', '/api/purchases/:id/simulate-pay'],
  ['GET', '/api/treasury'], ['GET', '/api/treasury/txs'],
  ['GET', '/api/agents'], ['GET', '/api/agents/:id'], ['PATCH', '/api/agents/:id'],
  ['GET', '/api/agents/:id/ledger'], ['GET', '/api/agents/:id/steps'], ['GET', '/api/agents/:id/steps/:stepId/transcript'],
  ['GET', '/api/agents/:id/events'], ['GET', '/api/agents/:id/live'],
  ['POST', '/api/agents/:id/withdraw'], ['POST', '/api/agents/:id/revive'], ['POST', '/api/agents/:id/recapitalize'],
  ['POST', '/api/agents/:id/topup'], ['POST', '/api/agents/:id/pause'], ['POST', '/api/agents/:id/terminate'],
  ['POST', '/api/agents/:id/message'],
  ['GET', '/api/me'], ['POST', '/api/me/payout-wallet'],
  ['GET', '/api/auth/nonce'], ['POST', '/api/auth/verify'], ['POST', '/api/auth/logout'],
  ['GET', '/api/market/bounties'], ['POST', '/api/market/bounties'], ['POST', '/api/market/bounties/:id/review'],
  ['GET', '/api/market/services'], ['POST', '/api/market/services/:id/call'],
  ['GET', '/ws'],
];
const V1_ROUTES_REMOVED: [string, string][] = [
  ['POST', '/api/agents'],                 // spawning only ever happens through a paid purchase
  ['POST', '/api/agents/:id/retry-seed'],  // the scheduler retries a stuck spawn now
  ['POST', '/api/me/refresh-holdings'],    // there is no token to hold
  ['GET', '/api/pool'], ['GET', '/api/pool/txs'],
];

describe('route inventory', () => {
  it('registers every v2 route and none of the v1 routes v2 deleted', () => {
    for (const [method, url] of V2_ROUTES) {
      expect(t.app.hasRoute({ method: method as 'GET', url }), `${method} ${url}`).toBe(true);
    }
    for (const [method, url] of V1_ROUTES_REMOVED) {
      expect(t.app.hasRoute({ method: method as 'GET', url }), `${method} ${url}`).toBe(false);
    }
  });
});

describe('GET /api/health', () => {
  it('reports the wiring, including whether a payment can be simulated', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(json<HealthResponse>(res)).toEqual({
      ok: true, version: t.deps.config.version, demo: true,
      chain: { mode: 'memory', cluster: 'memory' }, llm: 'mock', sandbox: 'local',
      payments: { mode: 'memory', simulateEnabled: true }, googleAuth: false, mainAgentId: AGENT_A, tokenLaunch: false,
    });
  });

  // MAIN_AGENT_ID is unset here, so the flagship is the colony's own longest-lived survivor —
  // GlobalStats.oldestAlive, which the stats memo already holds.
  it('features the oldest living agent when no operator override is configured', async () => {
    expect(t.deps.config.mainAgentId).toBe(null);
    const alone = await buildTestApp();
    try {
      alone.services.statsValue = makeStats({ oldestAlive: null });
      const res = await alone.app.inject({ method: 'GET', url: '/api/health' });
      expect(json<HealthResponse>(res).mainAgentId).toBe(null);
    } finally {
      await alone.close();
    }
  });
});

describe('GET /api/stats', () => {
  // Its own app: /api/health resolves the flagship through this same memo, so the shared one has
  // already been primed by the time this runs.
  it('memoizes Services.stats and takes fresh values from the bus', async () => {
    const fresh = await buildTestApp();
    try {
      const first = json<GlobalStats>(await fresh.app.inject({ method: 'GET', url: '/api/stats' }));
      const second = json<GlobalStats>(await fresh.app.inject({ method: 'GET', url: '/api/stats' }));
      expect(first.updatedAt).toBe(second.updatedAt);
      expect(fresh.services.callsTo('stats').length).toBe(1);

      fresh.deps.bus.emit({ type: 'stats', stats: makeStats({ alive: 99, updatedAt: '2026-09-17T00:00:00.000Z' }) });
      const third = json<GlobalStats>(await fresh.app.inject({ method: 'GET', url: '/api/stats' }));
      expect(third.alive).toBe(99);
      expect(fresh.services.callsTo('stats').length).toBe(1);
    } finally {
      await fresh.close();
    }
  });

  it('serves the series, event feed, leaderboard and models', async () => {
    await t.app.inject({ method: 'GET', url: '/api/stats/series' });
    expect(t.services.callsTo('series').at(-1)!.args).toEqual([30]);
    await t.app.inject({ method: 'GET', url: '/api/stats/series?days=7' });
    expect(t.services.callsTo('series').at(-1)!.args).toEqual([7]);

    await t.app.inject({ method: 'GET', url: '/api/events?limit=10&before=42&agentId=ag_x' });
    expect(t.services.callsTo('events').at(-1)!.args).toEqual([{ limit: 10, before: 42, agentId: 'ag_x' }]);

    await t.app.inject({ method: 'GET', url: '/api/leaderboard' });
    expect(t.services.callsTo('leaderboard').at(-1)!.args).toEqual(['revenue', 25]);
    await t.app.inject({ method: 'GET', url: '/api/leaderboard?by=profit&limit=5' });
    expect(t.services.callsTo('leaderboard').at(-1)!.args).toEqual(['profit', 5]);
    expect((await t.app.inject({ method: 'GET', url: '/api/leaderboard?by=vibes' })).statusCode).toBe(400);

    const models = await t.app.inject({ method: 'GET', url: '/api/models' });
    expect(json<ModelInfo[]>(models).every((m) => m.provider === 'mock')).toBe(true);
  });
});

// The pool is gone: there is no shared seed fund, only a treasury that holds what buyers paid.
describe('treasury', () => {
  it('serves the treasury and its ledger publicly, and the old pool paths are gone', async () => {
    const treasury = await t.app.inject({ method: 'GET', url: '/api/treasury' });
    expect(treasury.statusCode).toBe(200);
    const body = json<TreasuryPublic>(treasury);
    expect(body.purchasesMicro).toBe(30_000_000);
    expect(body.founderFeesMicro).toBe(3_000_000);
    expect(body.founderWallet).toBe('Founder1111');

    const txs = await t.app.inject({ method: 'GET', url: '/api/treasury/txs?limit=5' });
    expect(json<TreasuryTx[]>(txs)[0]!.kind).toBe('purchase');
    expect(t.services.callsTo('treasuryTxs').at(-1)!.args).toEqual([{ limit: 5 }]);
    expect((await t.app.inject({ method: 'GET', url: '/api/treasury/txs?limit=9999' })).statusCode).toBe(400);

    for (const gone of ['/api/pool', '/api/pool/txs']) {
      expect((await t.app.inject({ method: 'GET', url: gone })).statusCode, gone).toBe(404);
    }
  });
});

describe('market', () => {
  it('lists bounties and filters by status', async () => {
    const all = await t.app.inject({ method: 'GET', url: '/api/market/bounties' });
    expect(json<Bounty[]>(all)).toHaveLength(1);
    expect(t.services.callsTo('bounties').at(-1)!.args).toEqual([undefined]);

    const paid = await t.app.inject({ method: 'GET', url: '/api/market/bounties?status=paid' });
    expect(json<Bounty[]>(paid)).toHaveLength(0);
    expect((await t.app.inject({ method: 'GET', url: '/api/market/bounties?status=whatever' })).statusCode).toBe(400);
  });

  it('posts a bounty for the signed-in owner and validates the escrow fields', async () => {
    const payload = { title: 'Summarize a paper', description: 'One page', rewardMicro: 500_000, deadlineHours: 24, escrowTxSig: 'sig-escrow' };
    const anon = await t.app.inject(web({ method: 'POST', url: '/api/market/bounties', payload }));
    expect(anon.statusCode).toBe(401);

    const res = await t.app.inject(web({ method: 'POST', url: '/api/market/bounties', payload, headers: { cookie: ownerA } }));
    expect(res.statusCode).toBe(200);
    expect(json<Bounty>(res).posterId).toBe(OWNER_A);
    expect(t.services.callsTo('postBounty').at(-1)!.args[0]).toEqual({ posterType: 'user', posterWallet: OWNER_A, ...payload });

    for (const bad of [{ ...payload, rewardMicro: 0 }, { ...payload, deadlineHours: 400 }, { ...payload, title: 'x' }, { ...payload, escrowTxSig: '' }]) {
      expect((await t.app.inject(web({ method: 'POST', url: '/api/market/bounties', payload: bad, headers: { cookie: ownerA } }))).statusCode).toBe(400);
    }
  });

  it('lets only the posting owner review a bounty', async () => {
    const path = `/api/market/bounties/${t.services.bountyList[0]!.id}/review`;
    const foreign = await t.app.inject(web({ method: 'POST', url: path, payload: { approve: true }, headers: { cookie: ownerB } }));
    expect(foreign.statusCode).toBe(403);
    expect(json<ApiErrorBody>(foreign).error.code).toBe('FORBIDDEN');

    const unknown = await t.app.inject(web({ method: 'POST', url: '/api/market/bounties/bt_missing000/review', payload: { approve: true }, headers: { cookie: ownerA } }));
    expect(unknown.statusCode).toBe(404);

    const ok = await t.app.inject(web({ method: 'POST', url: path, payload: { approve: false, feedback: 'needs work' }, headers: { cookie: ownerA } }));
    expect(ok.statusCode).toBe(200);
    expect(json<Bounty>(ok).status).toBe('rejected');
    expect(t.services.callsTo('reviewBounty').at(-1)!.args).toEqual([t.services.bountyList[0]!.id, OWNER_A, false, 'needs work']);
  });

  it('calls a service as the signed-in buyer', async () => {
    const service = t.services.serviceList[0]!;
    const list = await t.app.inject({ method: 'GET', url: '/api/market/services' });
    expect(json<Service[]>(list)[0]!.id).toBe(service.id);

    const res = await t.app.inject(web({
      method: 'POST', url: `/api/market/services/${service.id}/call`,
      payload: { input: { text: 'hello' }, paymentTxSig: 'sig-pay' }, headers: { cookie: ownerA },
    }));
    expect(res.statusCode).toBe(200);
    expect(json<CallServiceResponse>(res)).toEqual({ output: { ok: true }, status: 'ok' });
    expect(t.services.callsTo('callService').at(-1)!.args).toEqual([
      service.id, { type: 'user', wallet: OWNER_A, paymentTxSig: 'sig-pay' }, { text: 'hello' },
    ]);

    const missingPayment = await t.app.inject(web({ method: 'POST', url: `/api/market/services/${service.id}/call`, payload: { input: {} }, headers: { cookie: ownerA } }));
    expect(missingPayment.statusCode).toBe(400);
  });
});

describe('GET /api/me', () => {
  it('returns the owner id for a wallet session and for a claim session', async () => {
    const wallet = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: ownerA } });
    expect(json<Me>(wallet)).toMatchObject({ ownerId: OWNER_A, ownerKind: 'wallet', wallet: OWNER_A });
    expect(t.services.callsTo('me').at(-1)!.args).toEqual([OWNER_A]);

    const claimCookie = await t.signIn(CLAIM_OWNER);
    const claim = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: claimCookie } });
    expect(json<Me>(claim)).toMatchObject({ ownerId: CLAIM_OWNER, ownerKind: 'claim', wallet: null });

    expect((await t.app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
  });

  it('refresh-holdings is gone; payout-wallet takes its place', async () => {
    const gone = await t.app.inject(web({ method: 'POST', url: '/api/me/refresh-holdings', headers: { cookie: ownerA } }));
    expect(gone.statusCode).toBe(404);

    const claimCookie = await t.signIn(CLAIM_OWNER);
    const set = await t.app.inject(web({ method: 'POST', url: '/api/me/payout-wallet', payload: { wallet: PAYOUT_WALLET }, headers: { cookie: claimCookie } }));
    expect(set.statusCode).toBe(200);
    expect(json<Me>(set).payoutWallet).toBe(PAYOUT_WALLET);
    expect(t.services.callsTo('setPayoutWallet').at(-1)!.args).toEqual([CLAIM_OWNER, PAYOUT_WALLET]);

    const bad = await t.app.inject(web({ method: 'POST', url: '/api/me/payout-wallet', payload: { wallet: 'not-a-pubkey' }, headers: { cookie: claimCookie } }));
    expect(bad.statusCode).toBe(400);

    const anon = await t.app.inject(web({ method: 'POST', url: '/api/me/payout-wallet', payload: { wallet: PAYOUT_WALLET } }));
    expect(anon.statusCode).toBe(401);
  });
});

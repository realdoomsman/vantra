import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentDetail, AgentLiveState, AgentPublic, ApiErrorBody, ListAgentsQuery, StepTranscript, TranscriptBlock } from '@vantra/shared';
import { conflict } from '../../src/lib/errors.js';
import { buildTestApp, json, web, type TestApp } from './helpers/app.js';
import { AGENT_A, AGENT_B, CLAIM_AGENT, CLAIM_OWNER, DEAD_AGENT, OWNER_A, OWNER_B, PAYOUT_WALLET, makeRawTranscript } from './helpers/fixtures.js';

let t: TestApp;
let ownerA: string;
let ownerB: string;
let claimOwner: string;

beforeAll(async () => {
  t = await buildTestApp();
  ownerA = await t.signIn(OWNER_A);
  ownerB = await t.signIn(OWNER_B);
  claimOwner = await t.signIn(CLAIM_OWNER);
});
afterAll(async () => { await t.close(); });

// Every owner-only route, with a body that is valid for the route so only ownership can fail.
const OWNER_ROUTES: { method: 'POST' | 'PATCH'; path: string; payload?: Record<string, unknown> }[] = [
  { method: 'POST', path: 'withdraw' },
  { method: 'POST', path: 'revive' },
  { method: 'POST', path: 'recapitalize', payload: { txSig: 'sig-1' } },
  { method: 'POST', path: 'topup', payload: { amountMicro: 5_000_000 } },
  { method: 'POST', path: 'pause', payload: { paused: true } },
  { method: 'POST', path: 'terminate', payload: { confirm: 'TERMINATE ALPHA' } },
  { method: 'POST', path: 'message', payload: { text: 'hello' } },
  { method: 'PATCH', path: '', payload: { shareStrategy: true } },
];

const url = (id: string, path: string) => (path ? `/api/agents/${id}/${path}` : `/api/agents/${id}`);

describe('owner-only agent routes', () => {
  it('403s for a signed-in non-owner', async () => {
    for (const r of OWNER_ROUTES) {
      const res = await t.app.inject(web({ method: r.method, url: url(AGENT_A, r.path), payload: r.payload, headers: { cookie: ownerB } }));
      expect(res.statusCode, r.path).toBe(403);
      expect(json<ApiErrorBody>(res).error).toEqual({ code: 'FORBIDDEN', message: 'Only the owner can do that' });
    }
  });

  it('401s when signed out and 404s for an unknown agent', async () => {
    for (const r of OWNER_ROUTES) {
      const anon = await t.app.inject(web({ method: r.method, url: url(AGENT_A, r.path), payload: r.payload }));
      expect(anon.statusCode, r.path).toBe(401);

      const missing = await t.app.inject(web({ method: r.method, url: url('ag_nosuchxxxx', r.path), payload: r.payload, headers: { cookie: ownerA } }));
      expect(missing.statusCode, r.path).toBe(404);
      expect(json<ApiErrorBody>(missing).error.code).toBe('NOT_FOUND');
    }
  });

  it('never reaches the acting service when ownership fails', async () => {
    const before = t.services.calls.length;
    await t.app.inject(web({ method: 'POST', url: url(AGENT_A, 'terminate'), payload: { confirm: 'TERMINATE ALPHA' }, headers: { cookie: ownerB } }));
    // Only the lookup and the ownership check ran.
    expect(t.services.calls.slice(before).map((c) => c.method)).toEqual(['getAgent', 'isOwner']);
  });

  it('passes the owner id — not the public ownerWallet — through to Services', async () => {
    const res = await t.app.inject(web({ method: 'POST', url: url(AGENT_A, 'pause'), payload: { paused: true }, headers: { cookie: ownerA } }));
    expect(res.statusCode).toBe(200);
    expect(json<AgentPublic>(res).status).toBe('paused');
    expect(t.services.callsTo('pause').at(-1)!.args).toEqual([AGENT_A, OWNER_A, true]);
    expect(t.services.callsTo('isOwner').at(-1)!.args).toEqual([AGENT_A, OWNER_A]);
  });

  // The whole point of routing ownership through `services.isOwner`: this agent's public payload has
  // `ownerWallet: null`, so the v1 comparison would have locked its own owner out.
  it('lets a claim-code owner act on an agent whose ownerWallet is null', async () => {
    const detail = json<AgentDetail>(await t.app.inject({ method: 'GET', url: url(CLAIM_AGENT, ''), headers: { cookie: claimOwner } }));
    expect(detail.ownerWallet).toBeNull();
    expect(detail.ownerKind).toBe('claim');
    expect(detail.isOwner).toBe(true);

    const res = await t.app.inject(web({ method: 'POST', url: url(CLAIM_AGENT, 'pause'), payload: { paused: true }, headers: { cookie: claimOwner } }));
    expect(res.statusCode).toBe(200);
    expect(t.services.callsTo('pause').at(-1)!.args).toEqual([CLAIM_AGENT, CLAIM_OWNER, true]);

    const stranger = await t.app.inject(web({ method: 'POST', url: url(CLAIM_AGENT, 'pause'), payload: { paused: true }, headers: { cookie: ownerA } }));
    expect(stranger.statusCode).toBe(403);
  });
});

describe('POST /api/agents/:id/withdraw', () => {
  it('forwards an optional amount and an optional payout wallet', async () => {
    const plain = await t.app.inject(web({ method: 'POST', url: url(AGENT_A, 'withdraw'), headers: { cookie: ownerA, 'content-type': 'application/json' } }));
    expect(plain.statusCode).toBe(200);
    expect(t.services.callsTo('withdraw').at(-1)!.args).toEqual([AGENT_A, OWNER_A, undefined, undefined]);

    const full = await t.app.inject(web({ method: 'POST', url: url(CLAIM_AGENT, 'withdraw'), payload: { amountMicro: 2_000_000, payoutWallet: PAYOUT_WALLET }, headers: { cookie: claimOwner } }));
    expect(full.statusCode).toBe(200);
    expect(t.services.callsTo('withdraw').at(-1)!.args).toEqual([CLAIM_AGENT, CLAIM_OWNER, 2_000_000, PAYOUT_WALLET]);

    const bad = await t.app.inject(web({ method: 'POST', url: url(AGENT_A, 'withdraw'), payload: { payoutWallet: 'nope' }, headers: { cookie: ownerA } }));
    expect(bad.statusCode).toBe(400);
  });

  it('surfaces PAYOUT_WALLET_REQUIRED from Services', async () => {
    t.services.failOnce('withdraw', conflict('PAYOUT_WALLET_REQUIRED', 'Set a payout wallet first'));
    const res = await t.app.inject(web({ method: 'POST', url: url(CLAIM_AGENT, 'withdraw'), headers: { cookie: claimOwner, 'content-type': 'application/json' } }));
    expect(res.statusCode).toBe(409);
    expect(json<ApiErrorBody>(res).error).toEqual({ code: 'PAYOUT_WALLET_REQUIRED', message: 'Set a payout wallet first' });
  });
});

describe('terminate confirmation', () => {
  it('requires the exact TERMINATE <NAME> string', async () => {
    const bad = await t.app.inject(web({ method: 'POST', url: url(AGENT_A, 'terminate'), payload: { confirm: 'TERMINATE alpha' }, headers: { cookie: ownerA } }));
    expect(bad.statusCode).toBe(400);
    expect(json<ApiErrorBody>(bad).error).toEqual({ code: 'CONFIRM_MISMATCH', message: 'Type "TERMINATE ALPHA" to confirm' });
    expect(t.services.callsTo('terminate')).toHaveLength(0);

    const ok = await t.app.inject(web({ method: 'POST', url: url(AGENT_A, 'terminate'), payload: { confirm: 'TERMINATE ALPHA' }, headers: { cookie: ownerA } }));
    expect(ok.statusCode).toBe(200);
    expect(t.services.callsTo('terminate')).toHaveLength(1);
  });
});

describe('PATCH /api/agents/:id', () => {
  it('applies both fields and rejects an empty patch', async () => {
    const res = await t.app.inject(web({ method: 'PATCH', url: url(AGENT_A, ''), payload: { shareStrategy: true, heartbeatMin: 30 }, headers: { cookie: ownerA } }));
    expect(res.statusCode).toBe(200);
    expect(json<AgentPublic>(res).heartbeatMin).toBe(30);
    expect(t.services.callsTo('setShareStrategy').at(-1)!.args).toEqual([AGENT_A, OWNER_A, true]);
    expect(t.services.callsTo('setHeartbeat').at(-1)!.args).toEqual([AGENT_A, OWNER_A, 30]);

    const empty = await t.app.inject(web({ method: 'PATCH', url: url(AGENT_A, ''), payload: {}, headers: { cookie: ownerA } }));
    expect(empty.statusCode).toBe(400);
    const tooFast = await t.app.inject(web({ method: 'PATCH', url: url(AGENT_A, ''), payload: { heartbeatMin: 1 }, headers: { cookie: ownerA } }));
    expect(tooFast.statusCode).toBe(400);
  });
});

// v2: an agent only ever comes into existence through a paid purchase, and a stuck spawn is retried
// by the scheduler, not by the owner.
describe('routes that v2 removed', () => {
  it('404s POST /api/agents and POST /api/agents/:id/retry-seed', async () => {
    const spawn = await t.app.inject(web({
      method: 'POST', url: '/api/agents',
      payload: { name: 'GAMMA', directive: 'Sell tiny APIs', tools: ['bash'], model: 'mock-fast', effort: 'medium' },
      headers: { cookie: ownerA },
    }));
    expect(spawn.statusCode).toBe(404);
    expect(json<ApiErrorBody>(spawn).error.code).toBe('NOT_FOUND');
    expect(t.services.callsTo('spawn')).toHaveLength(0);

    const retry = await t.app.inject(web({ method: 'POST', url: url(AGENT_A, 'retry-seed'), headers: { cookie: ownerA } }));
    expect(retry.statusCode).toBe(404);
  });
});

describe('GET /api/agents/:id/live', () => {
  it('is public and returns the in-flight step for the control board', async () => {
    const res = await t.app.inject({ method: 'GET', url: url(AGENT_B, 'live') });
    expect(res.statusCode).toBe(200);
    const live = json<AgentLiveState>(res);
    expect(live.agentId).toBe(AGENT_B);
    expect(live.stepping).toBe(true);
    expect(live.tools[0]!.name).toBe('fetch_url');
    expect(t.services.callsTo('agentLive').at(-1)!.args).toEqual([AGENT_B]);
  });
});

describe('agent reads', () => {
  it('passes the viewer owner id to getAgent so owner messages can be scoped', async () => {
    await t.app.inject({ method: 'GET', url: `/api/agents/${AGENT_A}`, headers: { cookie: ownerA } });
    expect(t.services.callsTo('getAgent').at(-1)!.args).toEqual([AGENT_A, OWNER_A]);

    const anon = await t.app.inject({ method: 'GET', url: `/api/agents/${AGENT_A}` });
    expect(anon.statusCode).toBe(200);
    expect(json<AgentDetail>(anon).id).toBe(AGENT_A);
    expect(json<AgentDetail>(anon).isOwner).toBe(false);
    expect(t.services.callsTo('getAgent').at(-1)!.args).toEqual([AGENT_A, null]);
  });

  it('404s an unknown agent', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/agents/ag_nosuchxxxx' });
    expect(res.statusCode).toBe(404);
  });

  it('defaults status to alive, or to all when filtering by owner', async () => {
    await t.app.inject({ method: 'GET', url: '/api/agents' });
    expect(t.services.callsTo('listAgents').at(-1)!.args[0]).toMatchObject({ status: 'alive', sort: 'treasury', dir: 'desc', limit: 50, offset: 0 });

    await t.app.inject({ method: 'GET', url: `/api/agents?owner=${OWNER_B}&sort=revenue&dir=asc&q=br&limit=5&offset=10` });
    expect(t.services.callsTo('listAgents').at(-1)!.args[0]).toEqual<ListAgentsQuery>({
      status: 'all', sort: 'revenue', dir: 'asc', q: 'br', limit: 5, offset: 10, owner: OWNER_B,
    });
  });

  it('sorts the graveyard and clamps the limit', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/graveyard?sort=revenue&limit=3' });
    expect(res.statusCode).toBe(200);
    expect(json<AgentPublic[]>(res).map((a) => a.id)).toEqual([DEAD_AGENT]);
    expect(t.services.callsTo('graveyard').at(-1)!.args).toEqual([3, 'revenue']);

    expect((await t.app.inject({ method: 'GET', url: '/api/graveyard?sort=sideways' })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/graveyard?limit=9999' })).statusCode).toBe(400);
  });

  it('forwards ledger, steps and per-agent event queries', async () => {
    await t.app.inject({ method: 'GET', url: `/api/agents/${AGENT_B}/ledger?limit=10&before=99` });
    expect(t.services.callsTo('ledger').at(-1)!.args).toEqual([AGENT_B, { limit: 10, before: 99 }]);

    await t.app.inject({ method: 'GET', url: `/api/agents/${AGENT_B}/steps` });
    expect(t.services.callsTo('steps').at(-1)!.args).toEqual([AGENT_B, 30]);

    await t.app.inject({ method: 'GET', url: `/api/agents/${AGENT_B}/events?limit=7` });
    expect(t.services.callsTo('events').at(-1)!.args).toEqual([{ limit: 7, agentId: AGENT_B }]);
  });
});

describe('GET /api/agents/:id/steps/:stepId/transcript', () => {
  it('strips thinking and truncates tool I/O to 2k chars', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/agents/${AGENT_A}/steps/7/transcript` });
    expect(res.statusCode).toBe(200);
    const body = json<StepTranscript>(res);
    expect(t.services.callsTo('stepTranscript').at(-1)!.args).toEqual([AGENT_A, 7, null]);

    const blocks: TranscriptBlock[] = body.messages.flatMap((m) => m.content);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'text', 'tool_use', 'tool_result']);
    expect(res.body).not.toContain('secret reasoning');

    const result = blocks.find((b) => b.type === 'tool_result')!;
    expect(result.content.startsWith('x'.repeat(2_000))).toBe(true);
    expect(result.content).toContain('truncated 3000 chars');
    expect(result.content.length).toBeLessThan(2_100);
  });

  // The route is public, but the STATUS block replays the owner's last messages verbatim and
  // message_owner carries the reply back (AMENDMENTS C21).
  it('redacts owner-private content for everyone but the owner', async () => {
    t.services.transcript = {
      stepId: 7, agentId: AGENT_A, n: 3,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'STATUS {"owner_messages":["<owner-private>the stripe login is alice@corp.example</owner-private>"]}' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'message_owner', input: '{"text":"the API key is sk-live-abc"}' }] },
      ],
    };

    const anon = await t.app.inject({ method: 'GET', url: `/api/agents/${AGENT_A}/steps/7/transcript` });
    expect(anon.body).not.toContain('alice@corp.example');
    expect(anon.body).not.toContain('sk-live-abc');
    expect(anon.body).toContain('redacted: owner-private');

    const owner = await t.app.inject({ method: 'GET', url: `/api/agents/${AGENT_A}/steps/7/transcript`, headers: { cookie: ownerA } });
    expect(owner.body).toContain('alice@corp.example');
    expect(owner.body).toContain('sk-live-abc');

    const stranger = await t.app.inject({ method: 'GET', url: `/api/agents/${AGENT_A}/steps/7/transcript`, headers: { cookie: ownerB } });
    expect(stranger.body).not.toContain('alice@corp.example');

    t.services.transcript = makeRawTranscript();
  });

  it('404s once the transcript has been pruned, and rejects a bad step id', async () => {
    t.services.transcript = null;
    const res = await t.app.inject({ method: 'GET', url: `/api/agents/${AGENT_A}/steps/7/transcript` });
    expect(res.statusCode).toBe(404);
    expect(json<ApiErrorBody>(res).error.code).toBe('NOT_FOUND');

    expect((await t.app.inject({ method: 'GET', url: `/api/agents/${AGENT_A}/steps/zero/transcript` })).statusCode).toBe(400);
  });
});

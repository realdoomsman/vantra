// POST /svc/:serviceId (SPEC §8.15) and the service runner behind it (§8.9, AMENDMENTS B19).
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVICE_PAYMENT_HEADER, type ApiErrorBody, type CallServiceResponse } from '@vantra/shared';
import type { LedgerKind, Micro } from '@vantra/shared';
import { hostingErrorHandler } from '../../src/hosting/index.js';
import { INTERNAL_CALL_HEADER, INTERNAL_CALL_TTL_MS, signInternalCall, verifyInternalCall } from '../../src/hosting/internal.js';
import {
  PAYMENT_MAX_AGE_MS, SERVICE_OUTPUT_MAX_BYTES, createServiceInvoker, createServiceRunner, sellerComputeMicro,
  type LedgerHook, type PaymentRefund, type ServiceRunner,
} from '../../src/hosting/service.js';
import { registerServiceEndpoint } from '../../src/hosting/svc.js';
import { systemClock } from '../../src/lib/clock.js';
import { silentLogger } from '../../src/lib/log.js';
import { SELLER, createFakeChain, createFakeSandbox, createFakeServiceStore, makeService, type FakeChain, type FakeSandbox, type FakeServiceStore } from './helpers/fakes.js';

const SECRET = 'test-session-secret-at-least-32-characters';
const SERVICE_ID = makeService().id;
const PRICE = makeService().priceMicro;
const BUYER_WALLET = 'BuyerWallet2222222222222222222222222222222';

interface LedgerPost { agentId: string; kind: LedgerKind; amountMicro: Micro; memo: string; meta: Record<string, unknown> }

let sandbox: FakeSandbox;
let chain: FakeChain;
let store: FakeServiceStore;
let posts: LedgerPost[];
let ledger: LedgerHook;
let runner: ServiceRunner;
let app: FastifyInstance;

beforeEach(async () => {
  sandbox = createFakeSandbox();
  chain = createFakeChain();
  store = createFakeServiceStore();
  posts = [];
  ledger = async (agentId, kind, amountMicro, memo, meta) => { posts.push({ agentId, kind, amountMicro, memo, meta }); };
  runner = createServiceRunner({ sandbox, chain, clock: systemClock, log: silentLogger }, store, ledger);
  app = Fastify({ logger: false });
  app.setErrorHandler(hostingErrorHandler(silentLogger));
  registerServiceEndpoint(app, { runner, secret: SECRET, clock: systemClock });
  await app.ready();
});
afterEach(async () => { await app?.close(); });

function paid(sig: string, over: Partial<{ to: string; amount: Micro; from: string; ts: Date }> = {}): string {
  chain.transfers.set(sig, { sig, from: over.from ?? BUYER_WALLET, to: over.to ?? SELLER.walletPubkey, amount: over.amount ?? PRICE, ts: over.ts ?? new Date() });
  return sig;
}

const post = (headers: Record<string, string>, payload: InjectOptions['payload'] = { text: 'hello' }, serviceId = SERVICE_ID): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'POST', url: `/svc/${serviceId}`, headers, payload });

const errorOf = (res: LightMyRequestResponse) => (JSON.parse(res.body) as ApiErrorBody).error;

describe('payment', () => {
  it('runs the handler and returns its JSON for a valid on-chain payment', async () => {
    sandbox.respond = (call) => ({ stdout: JSON.stringify({ echo: JSON.parse(call.stdin!) as unknown }), cpuMs: 12_000 });
    const res = await post({ [SERVICE_PAYMENT_HEADER]: paid('sig-ok') });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body) as CallServiceResponse).toEqual({ output: { echo: { text: 'hello' } }, status: 'ok' });
    expect(sandbox.execs[0]).toMatchObject({ agentId: SELLER.id, command: "node 'svc/handler.js'", stdin: '{"text":"hello"}', timeoutMs: 30_000 });
    expect(store.calls[0]).toMatchObject({ serviceId: SERVICE_ID, buyerType: 'user', buyerId: BUYER_WALLET, priceMicro: PRICE, status: 'ok', cpuMs: 12_000, paymentTx: 'sig-ok' });
    expect(store.service).toMatchObject({ calls: 1, revenueMicro: PRICE });
    expect(posts).toEqual([{ agentId: SELLER.id, kind: 'compute', amountMicro: -1_200, memo: 'service summarize call #1', meta: expect.any(Object) as unknown as Record<string, unknown> }]);
  });

  it('demands payment when neither header is present', async () => {
    const res = await post({});
    expect(res.statusCode).toBe(402);
    expect(errorOf(res).code).toBe('PAYMENT_REQUIRED');
    expect(sandbox.execs).toHaveLength(0);
  });

  it('rejects an unknown, misdirected, underpaid or overpaid tx before running anything', async () => {
    const cases: [string, Partial<{ to: string; amount: Micro; from: string; ts: Date }>][] = [
      ['sig-missing', {}],
      ['sig-wrong-payee', { to: 'SomeoneElse111111111111111111111111111111' }],
      ['sig-underpaid', { amount: PRICE - 1 }],
      // `>=` would turn every larger inbound transfer — the $10 seed included — into a coupon.
      ['sig-overpaid', { amount: PRICE * 200 }],
    ];
    for (const [sig, over] of cases) {
      if (sig !== 'sig-missing') paid(sig, over);
      const res = await post({ [SERVICE_PAYMENT_HEADER]: sig });
      expect(res.statusCode, sig).toBe(400);
      expect(errorOf(res).code).toBe('INVALID_TX');
    }
    expect(sandbox.execs).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
  });

  // Inbound transfers to an agent wallet are public: without a freshness bound anyone could replay a
  // signature lifted out of the explorer.
  it('rejects a payment older than the freshness window', async () => {
    paid('sig-stale', { ts: new Date(Date.now() - PAYMENT_MAX_AGE_MS - 60_000) });
    const res = await post({ [SERVICE_PAYMENT_HEADER]: 'sig-stale' });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('INVALID_TX');
    expect(errorOf(res).message).toContain('minutes old');
    expect(sandbox.execs).toHaveLength(0);
  });

  it('binds the payment to the signed-in caller when one is known', async () => {
    sandbox.respond = () => ({ stdout: '{}' });
    paid('sig-someone-else', { from: 'OtherWallet333333333333333333333333333333' });
    await expect(runner.call(SERVICE_ID, { type: 'user', paymentTxSig: 'sig-someone-else', wallet: BUYER_WALLET }, {}))
      .rejects.toThrow(/sent by/);

    paid('sig-mine');
    const ok = await runner.call(SERVICE_ID, { type: 'user', paymentTxSig: 'sig-mine', wallet: BUYER_WALLET }, {});
    expect(ok.status).toBe('ok');
  });

  it('refuses to let one payment buy two calls', async () => {
    sandbox.respond = () => ({ stdout: '{"ok":true}' });
    expect((await post({ [SERVICE_PAYMENT_HEADER]: paid('sig-once') })).statusCode).toBe(200);
    const again = await post({ [SERVICE_PAYMENT_HEADER]: 'sig-once' });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).code).toBe('INVALID_TX');
    expect(store.calls).toHaveLength(1);
  });

  it('maps a unique-violation race on the payment tx to 409', async () => {
    sandbox.respond = () => ({ stdout: '{}' });
    store.recordError = Object.assign(new Error('duplicate key'), { code: '23505' });
    const res = await post({ [SERVICE_PAYMENT_HEADER]: paid('sig-race') });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('INVALID_TX');
  });
});

describe('internal agent calls', () => {
  it('accepts a signed internal marker and records an agent buyer', async () => {
    sandbox.respond = () => ({ stdout: '{"ok":true}', cpuMs: 200 });
    const token = signInternalCall(SECRET, { agentId: 'ag_buyer0001', serviceId: SERVICE_ID, exp: Date.now() + INTERNAL_CALL_TTL_MS });
    const res = await post({ [INTERNAL_CALL_HEADER]: token });

    expect(res.statusCode).toBe(200);
    expect(store.calls[0]).toMatchObject({ buyerType: 'agent', buyerId: 'ag_buyer0001', paymentTx: null });
    expect(posts[0]!.amountMicro).toBe(-500);            // cpu floor, not cpuMs × rate
  });

  it('rejects a forged, expired or foreign-service marker', async () => {
    const claims = { agentId: 'ag_buyer0001', serviceId: SERVICE_ID, exp: Date.now() + INTERNAL_CALL_TTL_MS };
    const tokens = [
      signInternalCall('another-secret-that-is-at-least-32-chars!', claims),
      signInternalCall(SECRET, { ...claims, exp: Date.now() - 1 }),
      signInternalCall(SECRET, { ...claims, serviceId: 'sv_other00001' }),
      'garbage',
    ];
    for (const token of tokens) {
      const res = await post({ [INTERNAL_CALL_HEADER]: token });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('UNAUTHORIZED');
    }
    expect(sandbox.execs).toHaveLength(0);
  });

  it('verifies markers without leaking on bad hex or wrong length', () => {
    const claims = { agentId: 'ag_buyer0001', serviceId: SERVICE_ID, exp: Date.now() + 1_000 };
    const token = signInternalCall(SECRET, claims);
    expect(verifyInternalCall(SECRET, token, SERVICE_ID, Date.now())).toEqual(claims);
    expect(verifyInternalCall(SECRET, `${token}.extra`, SERVICE_ID, Date.now())).toBeNull();
    expect(verifyInternalCall(SECRET, token.replace(/\.[0-9a-f]+$/, '.zz'), SERVICE_ID, Date.now())).toBeNull();
    expect(() => signInternalCall(SECRET, { ...claims, agentId: 'a.b' })).toThrow();
  });

  it('refuses an agent buying from itself', async () => {
    const token = signInternalCall(SECRET, { agentId: SELLER.id, serviceId: SERVICE_ID, exp: Date.now() + INTERNAL_CALL_TTL_MS });
    const res = await post({ [INTERNAL_CALL_HEADER]: token });
    expect(res.statusCode).toBe(400);
  });
});

describe('service state', () => {
  it('404s an unknown service and 409s a paused one or a dead seller', async () => {
    expect((await post({ [SERVICE_PAYMENT_HEADER]: paid('s1') }, {}, 'sv_nope000001')).statusCode).toBe(404);

    store.service = makeService({ status: 'paused' });
    expect((await post({ [SERVICE_PAYMENT_HEADER]: paid('s2') })).statusCode).toBe(409);

    store.service = makeService();
    store.seller = { ...SELLER, status: 'dead' };
    const dead = await post({ [SERVICE_PAYMENT_HEADER]: paid('s3') });
    expect(dead.statusCode).toBe(409);
    expect(errorOf(dead).message).toContain('dead');
  });
});

describe('handler outcomes', () => {
  const cases: { name: string; exec: Partial<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>; status: string; check: (output: Record<string, string>) => void }[] = [
    { name: 'timeout', exec: { timedOut: true, stderr: 'killed' }, status: 'timeout', check: (o) => expect(o.error).toContain('timed out after 30s') },
    { name: 'non-zero exit', exec: { exitCode: 1, stderr: 'boom' }, status: 'error', check: (o) => expect(o.error).toContain('exited with code 1') },
    { name: 'invalid JSON', exec: { stdout: 'not json' }, status: 'error', check: (o) => expect(o.error).toContain('not valid JSON') },
    { name: 'oversized output', exec: { stdout: `"${'x'.repeat(SERVICE_OUTPUT_MAX_BYTES)}"` }, status: 'error', check: (o) => expect(o.error).toContain('exceeds') },
  ];

  for (const c of cases) {
    it(`reports ${c.name} as a recorded ${c.status} call and still charges the seller`, async () => {
      sandbox.respond = () => ({ cpuMs: 4_000, ...c.exec });
      const res = await post({ [SERVICE_PAYMENT_HEADER]: paid(`sig-${c.name.replace(/\s/g, '-')}`) });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as CallServiceResponse;
      expect(body.status).toBe(c.status);
      c.check(body.output as Record<string, string>);
      expect(store.calls[0]!.status).toBe(c.status);
      expect(posts[0]!.amountMicro).toBe(-sellerComputeMicro(4_000));
    });
  }

  // The human buyer pays before the handler runs, so a failure must give the money back — the agent
  // path already records price 0 and never charges (ECONOMICS-REVIEW).
  it('refunds a paid-up-front buyer when the handler fails, and books the refund', async () => {
    const refunds: { seller: string; to: string; amountMicro: Micro }[] = [];
    const refund: PaymentRefund = async (seller, to, amountMicro) => {
      refunds.push({ seller, to, amountMicro });
      return 'sig-refund';
    };
    runner = createServiceRunner({ sandbox, chain, clock: systemClock, log: silentLogger }, store, ledger, refund);
    sandbox.respond = () => ({ exitCode: 1, stderr: 'boom', cpuMs: 4_000 });

    const outcome = await runner.call(SERVICE_ID, { type: 'user', paymentTxSig: paid('sig-fail') }, {});

    expect(outcome.status).toBe('error');
    expect(refunds).toEqual([{ seller: SELLER.id, to: BUYER_WALLET, amountMicro: PRICE }]);
    expect(store.calls[0]).toMatchObject({ priceMicro: 0, status: 'error', paymentTx: 'sig-fail' });
    expect(store.service.revenueMicro).toBe(0);
    expect(posts[0]).toMatchObject({ agentId: SELLER.id, kind: 'payment', amountMicro: -PRICE });
    expect(posts[1]).toMatchObject({ kind: 'compute', amountMicro: -sellerComputeMicro(4_000) });
  });

  it('does not refund an agent buyer: the tool only pays on success', async () => {
    const refunds: string[] = [];
    runner = createServiceRunner(
      { sandbox, chain, clock: systemClock, log: silentLogger }, store, ledger,
      async (seller) => { refunds.push(seller); return 'sig-refund'; },
    );
    sandbox.respond = () => ({ timedOut: true, stderr: 'killed' });

    const outcome = await runner.call(SERVICE_ID, { type: 'agent', agentId: 'ag_buyer0001' }, {});

    expect(outcome.status).toBe('timeout');
    expect(refunds).toEqual([]);
  });

  it('returns an empty handler stdout as null', async () => {
    sandbox.respond = () => ({ stdout: '  \n' });
    const res = await post({ [SERVICE_PAYMENT_HEADER]: paid('sig-empty') });
    expect(JSON.parse(res.body) as CallServiceResponse).toEqual({ output: null, status: 'ok' });
  });

  it('survives a sandbox that throws', async () => {
    sandbox.respond = () => { throw new Error('docker daemon is gone'); };
    const res = await post({ [SERVICE_PAYMENT_HEADER]: paid('sig-throw') });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as CallServiceResponse).status).toBe('error');
  });

  it('answers even when the ledger post fails', async () => {
    sandbox.respond = () => ({ stdout: '{"ok":true}' });
    runner = createServiceRunner({ sandbox, chain, clock: systemClock, log: silentLogger }, store, async () => { throw new Error('db down'); });
    const app2 = Fastify({ logger: false });
    app2.setErrorHandler(hostingErrorHandler(silentLogger));
    registerServiceEndpoint(app2, { runner, secret: SECRET, clock: systemClock });
    const res = await app2.inject({ method: 'POST', url: `/svc/${SERVICE_ID}`, headers: { [SERVICE_PAYMENT_HEADER]: paid('sig-ledger') }, payload: {} });
    expect(res.statusCode).toBe(200);
    await app2.close();
  });
});

describe('size limits', () => {
  it('rejects a request body over 64KB', async () => {
    const res = await post({ [SERVICE_PAYMENT_HEADER]: paid('sig-big'), 'content-type': 'application/json' }, { blob: 'x'.repeat(70 * 1024) });
    expect(res.statusCode).toBe(413);
    expect(errorOf(res).code).toBe('PAYLOAD_TOO_LARGE');
    expect(sandbox.execs).toHaveLength(0);
  });
});

describe('sellerComputeMicro', () => {
  it('floors at the service_call_min and then bills $0.0001 per cpu second', () => {
    expect(sellerComputeMicro(0)).toBe(500);
    expect(sellerComputeMicro(4_999)).toBe(500);
    expect(sellerComputeMicro(5_000)).toBe(500);
    expect(sellerComputeMicro(12_000)).toBe(1_200);
  });
});

describe('createServiceInvoker', () => {
  it('runs the handler and bills the seller without taking payment or recording a call', async () => {
    sandbox.respond = (call) => ({ stdout: call.stdin!, cpuMs: 30_000 });
    const invoker = createServiceInvoker({ sandbox, log: silentLogger }, ledger);
    const result = await invoker.invoke(makeService(), { q: 1 }, { remainingMs: 5_000 });

    expect(result).toEqual({ output: { q: 1 }, status: 'ok', cpuMs: 30_000 });
    expect(sandbox.execs[0]!.timeoutMs).toBe(5_000);           // capped by the remaining step time
    expect(store.calls).toHaveLength(0);
    expect(posts).toEqual([{ agentId: SELLER.id, kind: 'compute', amountMicro: -3_000, memo: 'service summarize handler run', meta: expect.any(Object) as unknown as Record<string, unknown> }]);
  });

  it('caps the handler at the 30s service timeout', async () => {
    sandbox.respond = () => ({ stdout: '{}' });
    await createServiceInvoker({ sandbox, log: silentLogger }, ledger).invoke(makeService(), {}, { remainingMs: 10 * 60_000 });
    expect(sandbox.execs[0]!.timeoutMs).toBe(30_000);
  });

  it('rejects an input larger than 64KB', async () => {
    const invoker = createServiceInvoker({ sandbox, log: silentLogger }, ledger);
    await expect(invoker.invoke(makeService(), { blob: 'x'.repeat(70 * 1024) })).rejects.toMatchObject({ status: 413 });
  });
});

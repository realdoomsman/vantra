// Every failure leaves as `{ error: { code, message } }` — including Fastify's own parser and
// limit errors, and anything a Service throws.
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody } from '@vantra/shared';
import { createApp, BODY_LIMIT_BYTES } from '../../src/http/server.js';
import { conflict } from '../../src/lib/errors.js';
import { buildTestApp, json, makeDeps, web, type TestApp } from './helpers/app.js';
import { AGENT_B, OWNER_B } from './helpers/fixtures.js';
import { createMemoryAuthStore } from './helpers/memoryAuthStore.js';

let t: TestApp;
afterEach(async () => { await t?.close(); });

describe('error envelope', () => {
  it('shapes 404s, validation errors and service conflicts the same way', async () => {
    t = await buildTestApp();

    const missing = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain('application/json');
    expect(json<ApiErrorBody>(missing).error).toEqual({ code: 'NOT_FOUND', message: 'GET /api/nope not found' });

    const invalid = await t.app.inject({ method: 'GET', url: '/api/stats/series?days=999' });
    expect(invalid.statusCode).toBe(400);
    expect(json<ApiErrorBody>(invalid).error.code).toBe('BAD_REQUEST');
    expect(json<ApiErrorBody>(invalid).error.message).toContain('days');

    t.services.failOnce('treasury', conflict('NOT_ELIGIBLE', 'treasury is resyncing'));
    const conflicted = await t.app.inject({ method: 'GET', url: '/api/treasury' });
    expect(conflicted.statusCode).toBe(409);
    expect(json<ApiErrorBody>(conflicted).error).toEqual({ code: 'NOT_ELIGIBLE', message: 'treasury is resyncing' });
  });

  it('never leaks an unexpected error message', async () => {
    t = await buildTestApp();
    t.services.failOnce('stats', new Error('connection to postgres://user:pw@host failed'));
    const res = await t.app.inject({ method: 'GET', url: '/api/stats' });
    expect(res.statusCode).toBe(500);
    expect(json<ApiErrorBody>(res).error).toEqual({ code: 'INTERNAL', message: 'Internal error' });
    expect(res.body).not.toContain('postgres');
  });

  it('answers a serves-before-Services request with 503, and the same for Payments', async () => {
    const deps = makeDeps();
    delete deps.services;   // the container attaches Services after the app is built
    delete deps.payments;
    const app = await createApp(deps, { hosting: null, authStore: createMemoryAuthStore() });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(res.statusCode).toBe(503);
    expect(json<ApiErrorBody>(res).error).toEqual({ code: 'UNAVAILABLE', message: 'Services are not ready' });

    const tiers = await app.inject({ method: 'GET', url: '/api/tiers' });
    expect(tiers.statusCode).toBe(503);
    expect(json<ApiErrorBody>(tiers).error).toEqual({ code: 'UNAVAILABLE', message: 'Payments are not ready' });
    await app.close();
  });

  it('rejects malformed JSON, the wrong media type and oversized bodies', async () => {
    t = await buildTestApp();
    const post = (payload: string, contentType: string) => t.app.inject(web({
      method: 'POST', url: '/api/auth/demo', payload, headers: { 'content-type': contentType },
    }));

    const broken = await post('{"wallet":', 'application/json');
    expect(broken.statusCode).toBe(400);
    expect(json<ApiErrorBody>(broken).error.code).toBe('BAD_REQUEST');

    const wrongType = await post('<wallet>demo-wallet-1</wallet>', 'application/xml');
    expect(wrongType.statusCode).toBe(415);
    expect(json<ApiErrorBody>(wrongType).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    const huge = await post(JSON.stringify({ wallet: 'x'.repeat(BODY_LIMIT_BYTES) }), 'application/json');
    expect(huge.statusCode).toBe(413);
    expect(json<ApiErrorBody>(huge).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('accepts a bodiless POST that still declares a JSON content type', async () => {
    t = await buildTestApp();
    const cookie = await t.signIn(OWNER_B);
    for (const url of [`/api/agents/${AGENT_B}/revive`, `/api/agents/${AGENT_B}/withdraw`, '/api/auth/logout']) {
      const res = await t.app.inject(web({ method: 'POST', url, headers: { cookie, 'content-type': 'application/json' } }));
      expect(res.statusCode, url).toBe(200);
    }
  });

  it('keeps a JSON 404 for API paths even when the client asks for HTML', async () => {
    t = await buildTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/agents/ag_x/nope', headers: { accept: 'text/html' } });
    expect(res.statusCode).toBe(404);
    expect(json<ApiErrorBody>(res).error.code).toBe('NOT_FOUND');
  });
});

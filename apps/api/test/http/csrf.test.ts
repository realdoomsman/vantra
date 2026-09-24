import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT_HEADER, type ApiErrorBody } from '@vantra/shared';
import { buildTestApp, json, PUBLIC_URL, type TestApp } from './helpers/app.js';

let t: TestApp;
beforeAll(async () => { t = await buildTestApp(); });
afterAll(async () => { await t.close(); });

describe('CSRF defence', () => {
  it('rejects mutating /api calls without the client header', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(res.statusCode).toBe(403);
    expect(json<ApiErrorBody>(res).error).toEqual({ code: 'FORBIDDEN', message: `Missing ${CLIENT_HEADER} header` });
  });

  it('rejects a cross-origin Origin even with the header', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { [CLIENT_HEADER]: 'web', origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
    expect(json<ApiErrorBody>(res).error.message).toMatch(/cross-origin/i);
  });

  it('accepts the web origin and the API origin', async () => {
    for (const origin of [PUBLIC_URL, t.deps.config.apiUrl, `${PUBLIC_URL}/`]) {
      const res = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { [CLIENT_HEADER]: 'web', origin } });
      expect(res.statusCode, origin).toBe(200);
    }
  });

  it('accepts requests with the header and no Origin (non-browser clients)', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { [CLIENT_HEADER]: 'web' } });
    expect(res.statusCode).toBe(200);
  });

  // Hosted agent sites share this origin unless the operator gives them their own hostname. Their
  // CSP sandbox already strips it, but a page that kept it must still not spend a visitor's session.
  it('rejects mutating calls that came from a hosted agent site', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/logout',
      headers: { [CLIENT_HEADER]: 'web', origin: t.deps.config.apiUrl, referer: `${t.deps.config.apiUrl}/sites/atlas/index.html` },
    });
    expect(res.statusCode).toBe(403);
    expect(json<ApiErrorBody>(res).error.message).toMatch(/hosted agent sites/);

    const fromApp = await t.app.inject({
      method: 'POST', url: '/api/auth/logout',
      headers: { [CLIENT_HEADER]: 'web', origin: PUBLIC_URL, referer: `${PUBLIC_URL}/a/ag_x` },
    });
    expect(fromApp.statusCode).toBe(200);
  });

  it('does not apply to GET or to non-/api paths', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://evil.example' } })).statusCode).toBe(200);
    // /svc is the public service endpoint (hosting module); the guard must not intercept it.
    expect((await t.app.inject({ method: 'POST', url: '/svc/sv_x', payload: {} })).statusCode).toBe(404);
  });

  it('answers CORS preflight for the web origin with credentials', async () => {
    const res = await t.app.inject({ method: 'OPTIONS', url: '/api/purchases', headers: { origin: PUBLIC_URL, 'access-control-request-method': 'POST', 'access-control-request-headers': CLIENT_HEADER } });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(PUBLIC_URL);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(String(res.headers['access-control-allow-headers'])).toContain(CLIENT_HEADER);
  });

  it('sets security headers', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['strict-transport-security']).toBeUndefined();   // not production
  });
});

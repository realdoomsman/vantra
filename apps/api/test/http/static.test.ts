// Production mode: the API also serves apps/web/dist at / with an SPA fallback (SPEC §8.15).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiErrorBody } from '@vantra/shared';
import { buildTestApp, PROD_ENV, type TestApp } from './helpers/app.js';

const INDEX_HTML = '<!doctype html><title>VANTRA</title><div id="root"></div>';

let dist: string;
let t: TestApp;

beforeAll(async () => {
  dist = await mkdtemp(path.join(tmpdir(), 'vantra-web-'));
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await writeFile(path.join(dist, 'index.html'), INDEX_HTML);
  await writeFile(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  t = await buildTestApp({ env: PROD_ENV, webDist: dist });
});

afterAll(async () => {
  await t?.close();
  await rm(dist, { recursive: true, force: true });
});

describe('web app hosting', () => {
  it('serves index.html and hashed assets with the right cache headers', async () => {
    const index = await t.app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('id="root"');
    expect(index.headers['cache-control']).toBe('no-cache');

    const asset = await t.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    // The security hooks are added after the static plugin; they must still cover its routes.
    expect(index.headers['x-content-type-options']).toBe('nosniff');
    expect(index.headers['x-frame-options']).toBe('DENY');
    expect(index.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });

  it('falls back to the SPA shell for deep links but never for API paths', async () => {
    const deep = await t.app.inject({ method: 'GET', url: '/a/ag_aaaaaaaaaa', headers: { accept: 'text/html' } });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('id="root"');

    for (const url of ['/api/nope', '/sites/gone/index.html', '/svc/sv_gone']) {
      const res = await t.app.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).toContain('application/json');
      expect(JSON.parse(res.body) as ApiErrorBody).toHaveProperty('error.code', 'NOT_FOUND');
    }

    // Non-HTML clients (fetch, curl) get JSON, not the shell.
    const api = await t.app.inject({ method: 'GET', url: '/unknown' });
    expect(api.statusCode).toBe(404);
    expect(JSON.parse(api.body) as ApiErrorBody).toHaveProperty('error.code', 'NOT_FOUND');
  });

  it('sets HSTS in production', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });

  it('serves the API only when there is no build', async () => {
    const noBuild = await buildTestApp({ env: PROD_ENV, webDist: path.join(dist, 'missing') });
    const html = await noBuild.app.inject({ method: 'GET', url: '/a/ag_x', headers: { accept: 'text/html' } });
    expect(html.statusCode).toBe(404);
    expect(JSON.parse(html.body) as ApiErrorBody).toHaveProperty('error.code', 'NOT_FOUND');
    expect((await noBuild.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    await noBuild.close();
  });
});

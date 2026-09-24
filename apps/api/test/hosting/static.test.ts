// GET /sites/:slug/* — deployed agent sites (SPEC §8.15): index.html default, no listing, 1h cache,
// allow-listed extensions, and headers that stop a hosted site attacking the observatory.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SITE_CSP } from '../../src/hosting/static.js';
import { buildHostingApp } from './helpers/app.js';

let dataDir: string;
let app: FastifyInstance;
const sitePath = (...rel: string[]) => path.join(dataDir, 'sites', ...rel);

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'vantra-sites-'));
  await mkdir(sitePath('demo', 'sub'), { recursive: true });
  await writeFile(sitePath('demo', 'index.html'), '<h1>DEMO</h1>', 'utf8');
  await writeFile(sitePath('demo', 'app.css'), 'body{color:#0f0}', 'utf8');
  await writeFile(sitePath('demo', 'secrets.env'), 'KEY=1', 'utf8');
  await writeFile(sitePath('demo', '.env'), 'KEY=1', 'utf8');
  await writeFile(sitePath('demo', 'sub', 'index.html'), '<h1>SUB</h1>', 'utf8');
  ({ app } = await buildHostingApp({ dataDir }));
});
afterEach(async () => {
  await app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

describe('serving', () => {
  it('serves index.html at the site root with hardened headers and a 1h cache', async () => {
    const res = await get('/sites/demo/');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<h1>DEMO</h1>');
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.headers['content-security-policy']).toBe(SITE_CSP);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves allow-listed assets with their content type', async () => {
    const res = await get('/sites/demo/app.css');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(res.body).toBe('body{color:#0f0}');
  });

  it('redirects a bare slug and a directory to their trailing-slash form', async () => {
    expect(await get('/sites/demo')).toMatchObject({ statusCode: 301, headers: { location: '/sites/demo/' } });
    expect(await get('/sites/demo/sub')).toMatchObject({ statusCode: 301, headers: { location: '/sites/demo/sub/' } });
    expect((await get('/sites/demo/sub/')).body).toBe('<h1>SUB</h1>');
  });

  it('ignores the Host header so SITES_BASE_URL may point at another hostname', async () => {
    const res = await get('/sites/demo/', { host: 'sites.vantra.xyz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<h1>DEMO</h1>');
  });
});

describe('blocked paths', () => {
  it('404s extensions that are not on the deploy allow-list and hidden files', async () => {
    for (const url of ['/sites/demo/secrets.env', '/sites/demo/.env']) {
      const res = await get(url);
      expect(res.statusCode).toBe(404);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('404s traversal, encoded traversal and unknown slugs without listing directories', async () => {
    for (const url of ['/sites/demo/..%2f..%2fetc%2fpasswd', '/sites/demo/%2e%2e/%2e%2e/config.json', '/sites/DEMO/', '/sites/nope/', '/sites/demo/sub/../.env']) {
      expect((await get(url)).statusCode).toBe(404);
    }
  });

  it('404s a directory with no index.html instead of listing it', async () => {
    await mkdir(sitePath('demo', 'assets'), { recursive: true });
    await writeFile(sitePath('demo', 'assets', 'logo.svg'), '<svg/>', 'utf8');
    expect((await get('/sites/demo/assets/')).statusCode).toBe(404);
    expect((await get('/sites/demo/assets/logo.svg')).statusCode).toBe(200);
  });

  it('refuses to follow a symlink out of the site directory', async () => {
    await writeFile(path.join(dataDir, 'outside.html'), 'SECRET', 'utf8');
    await symlink(path.join(dataDir, 'outside.html'), sitePath('demo', 'leak.html'));
    const res = await get('/sites/demo/leak.html');
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('SECRET');
  });

  it('keeps the hardened headers on 404s and on other sites', async () => {
    const res = await get('/sites/nope/');
    expect(res.headers['content-security-policy']).toBe(SITE_CSP);
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  // These pages are written by competing autonomous agents and are served from the API's own origin
  // unless the operator gives them a hostname of their own. Without the sandbox directive their
  // JavaScript runs AS the app, with the visitor's session cookie.
  it('denies hosted sites the app origin and any silent channel out', () => {
    const directives = new Map(SITE_CSP.split('; ').map((d) => {
      const [name, ...rest] = d.split(' ');
      return [name!, rest.join(' ')];
    }));

    expect(directives.get('sandbox')).toBeDefined();
    expect(directives.get('sandbox')).not.toContain('allow-same-origin');
    expect(directives.get('sandbox')).toContain('allow-scripts');
    expect(directives.get('img-src')).toBe("'self' data:");       // no `img-src *` beacon
    expect(directives.get('connect-src')).toBe("'self'");
    expect(directives.get('form-action')).toBe("'none'");
    expect(directives.get('base-uri')).toBe("'none'");
    expect(directives.get('frame-ancestors')).toBe("'none'");
  });
});

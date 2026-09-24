// deploy_site support (SPEC §8.9): export the sandbox dir, validate it as a static site, swap it in.
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SITE_MAX_BYTES, deploySite, removeSite, siteUrl, type DeployContext } from '../../src/hosting/deploy.js';
import { ApiError } from '../../src/lib/errors.js';
import { systemClock } from '../../src/lib/clock.js';
import { silentLogger } from '../../src/lib/log.js';
import { createFakeDeploymentStore, createFakeSandbox, type FakeDeploymentStore, type FakeSandbox } from './helpers/fakes.js';

const AGENT = 'ag_builder01';
const SITES_BASE_URL = 'http://localhost:8787/sites';

let root: string;
let sandbox: FakeSandbox;
let store: FakeDeploymentStore;
let ctx: DeployContext;
const sitesDir = () => path.join(root, 'sites');

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vantra-deploy-'));
  sandbox = createFakeSandbox();
  store = createFakeDeploymentStore();
  ctx = { sandbox, store, sitesDir: sitesDir(), sitesBaseUrl: SITES_BASE_URL, clock: systemClock, log: silentLogger };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const expectApiError = async (p: Promise<unknown>, match: RegExp): Promise<ApiError> => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).message).toMatch(match);
  return err as ApiError;
};

describe('deploySite', () => {
  it('publishes the exported tree and records the deployment', async () => {
    sandbox.setTree(AGENT, 'site', { 'index.html': '<h1>hi</h1>', 'css/app.css': 'body{}', 'logo.svg': '<svg/>' });
    const result = await deploySite(ctx, AGENT, 'site', 'builder');

    expect(result).toEqual({ slug: 'builder', url: `${SITES_BASE_URL}/builder/`, bytes: 23, files: 3 });
    expect(await readFile(path.join(sitesDir(), 'builder', 'index.html'), 'utf8')).toBe('<h1>hi</h1>');
    expect(await readFile(path.join(sitesDir(), 'builder', 'css', 'app.css'), 'utf8')).toBe('body{}');
    expect(store.rows).toEqual([{ agentId: AGENT, slug: 'builder', dirSizeBytes: 23, deployedAt: expect.any(Date) as unknown as Date, active: true }]);
    expect(siteUrl(SITES_BASE_URL, 'builder')).toBe(`${SITES_BASE_URL}/builder/`);
  });

  it('replaces the previous deployment without leaving stale files or staging dirs', async () => {
    sandbox.setTree(AGENT, 'site', { 'index.html': 'v1', 'old.html': 'gone' });
    await deploySite(ctx, AGENT, 'site', 'builder');
    sandbox.setTree(AGENT, 'site', { 'index.html': 'v2' });
    await deploySite(ctx, AGENT, 'site', 'builder');

    expect(await readdir(path.join(sitesDir(), 'builder'))).toEqual(['index.html']);
    expect(await readFile(path.join(sitesDir(), 'builder', 'index.html'), 'utf8')).toBe('v2');
    expect(await readdir(sitesDir())).toEqual(['builder']);
    expect(store.rows).toHaveLength(1);
  });

  it('drops hidden entries and rejects files that cannot be hosted', async () => {
    sandbox.setTree(AGENT, 'site', { 'index.html': 'ok', '.env': 'KEY=1', '.git/config': 'x' });
    await deploySite(ctx, AGENT, 'site', 'builder');
    expect(await readdir(path.join(sitesDir(), 'builder'))).toEqual(['index.html']);

    sandbox.setTree(AGENT, 'site', { 'index.html': 'ok', 'server.py': 'print(1)' });
    await expectApiError(deploySite(ctx, AGENT, 'site', 'builder2'), /server\.py/);
    expect(await readdir(sitesDir())).toEqual(['builder']);      // nothing half-written
  });

  it('requires an index.html at the root', async () => {
    sandbox.setTree(AGENT, 'site', { 'about.html': 'hi' });
    await expectApiError(deploySite(ctx, AGENT, 'site', 'builder'), /index\.html/);
  });

  it('turns the sandbox size cap into an agent-readable error', async () => {
    sandbox.setTree(AGENT, 'site', { 'index.html': 'x'.repeat(SITE_MAX_BYTES + 1) });
    await expectApiError(deploySite(ctx, AGENT, 'site', 'builder'), /exceeds 20MB/);
  });

  it('reports a missing directory instead of throwing out of the tool', async () => {
    await expect(deploySite(ctx, AGENT, 'nope', 'builder')).rejects.toThrow(/no such directory/);
  });

  it('refuses a slug held by another agent and invalid slugs', async () => {
    sandbox.setTree(AGENT, 'site', { 'index.html': 'ok' });
    await deploySite(ctx, AGENT, 'site', 'builder');
    sandbox.setTree('ag_other0001', 'site', { 'index.html': 'ok' });
    const conflict = await expectApiError(deploySite(ctx, 'ag_other0001', 'site', 'builder'), /another agent/);
    expect(conflict.status).toBe(409);
    for (const slug of ['../etc', 'UPPER', 'has space', '']) {
      expect((await expectApiError(deploySite(ctx, AGENT, 'site', slug), /invalid site slug/)).status).toBe(400);
    }
  });
});

describe('removeSite', () => {
  it('removes the files and deactivates the deployment rows', async () => {
    sandbox.setTree(AGENT, 'site', { 'index.html': 'ok' });
    await deploySite(ctx, AGENT, 'site', 'builder');
    expect(await removeSite(ctx, 'builder')).toBe(true);
    expect(await readdir(sitesDir())).toEqual([]);
    expect(store.rows[0]!.active).toBe(false);
  });

  it('is idempotent for a slug that was never deployed', async () => {
    expect(await removeSite(ctx, 'ghost')).toBe(false);
  });
});

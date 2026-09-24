// deploy_site (slug ownership, hosting cost, the auto-created site project) and the read-only
// wallet tool. SPEC §8.9.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { TOOL_COST_MICRO } from '@vantra/shared';
import type { ToolRegistry } from '../../src/core/interfaces.js';
import type { AgentRow } from '../../src/db/schema.js';
import { agents, ledger, projects } from '../../src/db/schema.js';
import { resolveSlug } from '../../src/tools/deploy.js';
import { createToolRegistry } from '../../src/tools/index.js';
import { WALLET_HISTORY_ROWS } from '../../src/tools/wallet.js';
import { ctxFor, execOpts, fakeChain, fakePorts, lockTestDb, seedAgent, testDbAvailable, testDeps, type FakePorts, type TestDb, type TestDeps } from './helpers/env.js';

describe('resolveSlug', () => {
  it('defaults to the agent’s own slug', () => {
    expect(resolveSlug('atlas', undefined)).toBe('atlas');
  });

  it('allows a suffixed slug the agent owns', () => {
    expect(resolveSlug('atlas', 'atlas-docs')).toBe('atlas-docs');
    expect(resolveSlug('atlas', 'ATLAS-Docs')).toBe('atlas-docs');
  });

  it('refuses another agent’s slug and malformed slugs', () => {
    expect(() => resolveSlug('atlas', 'rival')).toThrow(/must be "atlas"/);
    expect(() => resolveSlug('atlas', 'atlasdocs')).toThrow(/must be "atlas"/);
    expect(() => resolveSlug('atlas', '-atlas')).toThrow(/lowercase/);
    expect(() => resolveSlug('atlas', 'a')).toThrow(/lowercase/);
    expect(() => resolveSlug('atlas', 'atlas/../etc')).toThrow(/lowercase/);
  });
});

const hasDb = await testDbAvailable();
const suite = hasDb ? describe : describe.skip;

suite('deploy_site and wallet', () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let ports: FakePorts;
  let registry: ToolRegistry;
  let agent: AgentRow;

  const run = (name: string, input: unknown) => registry.execute(ctxFor(agent), name, input, execOpts());

  beforeAll(async () => { testDb = await lockTestDb(); });
  afterAll(async () => { await testDb.close(); });

  beforeEach(async () => {
    await testDb.reset();
    ports = fakePorts();
    deps = testDeps(testDb.db, { chain: fakeChain({ wallet_deployer: { usdc: 7_250_000, sol: 4_800_000 } }) });
    registry = createToolRegistry(deps, ports);
    agent = await seedAgent(deps.db, deps.clock, { name: 'DEPLOYER' });
  });


  describe('deploy_site', () => {
    it('publishes the directory, charges the deploy fee and returns the URL', async () => {
      const res = await run('deploy_site', { dir: 'site' });

      expect(res.costMicro).toBe(TOOL_COST_MICRO['deploy_site']);
      expect(ports.deploy.deploys).toEqual([{ agentId: agent.id, dir: 'site', slug: 'deployer' }]);
      expect(res.content).toContain('http://localhost:8787/sites/deployer/');
      expect(res.event).toMatchObject({ kind: 'deploy' });
    });

    it('auto-creates a site project the first time and leaves it alone afterwards', async () => {
      await run('deploy_site', { dir: 'site' });
      const [created] = await deps.db.select().from(projects).where(eq(projects.agentId, agent.id));
      expect(created).toMatchObject({ kind: 'site', status: 'live', url: 'http://localhost:8787/sites/deployer/' });

      await deps.db.update(projects).set({ name: 'Renamed', description: 'Mine' }).where(eq(projects.id, created!.id));
      await run('deploy_site', { dir: 'site' });
      const rows = await deps.db.select().from(projects).where(eq(projects.agentId, agent.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.name).toBe('Renamed');
    });

    it('refuses the /work root and a slug owned by someone else', async () => {
      expect((await run('deploy_site', { dir: '.' })).isError).toBe(true);
      const stolen = await run('deploy_site', { dir: 'site', slug: 'rival-site' });
      expect(stolen.isError).toBe(true);
      expect(ports.deploy.deploys).toHaveLength(0);
    });

    it('turns a hosting failure into a tool error and charges nothing', async () => {
      ports.deploy.deploySite = () => Promise.reject(new Error('site directory must contain index.html at its root'));
      const res = await run('deploy_site', { dir: 'site' });
      expect(res.isError).toBe(true);
      expect(res.content).toContain('index.html');
      expect(res.costMicro).toBe(0);
    });
  });

  describe('wallet', () => {
    it('returns the balance shape the spec fixes', async () => {
      await deps.db.update(agents).set({ unsettledMicro: 123_456 }).where(eq(agents.id, agent.id));

      const res = await run('wallet', { action: 'balance' });
      expect(res.costMicro).toBe(0);
      expect(JSON.parse(res.content)).toEqual({
        address: 'wallet_deployer', usdcMicro: 7_250_000, ethGwei: 4_800_000, unsettledMicro: 123_456,
        cluster: 'memory', token: null,
      });
    });

    it('reports an empty history plainly and lists the newest entries first', async () => {
      expect((await run('wallet', { action: 'history' })).content).toBe('No ledger entries yet.');

      const now = deps.clock.now();
      for (let i = 0; i < WALLET_HISTORY_ROWS + 5; i++) {
        await deps.db.insert(ledger).values({
          agentId: agent.id, ts: new Date(now.getTime() + i * 1_000), kind: 'inference',
          amountMicro: -(i + 1) * 100, balanceAfterMicro: 10_000_000 - (i + 1) * 100, memo: `step ${i}`,
        });
      }
      const res = await run('wallet', { action: 'history' });
      const lines = res.content.split('\n');
      expect(lines).toHaveLength(WALLET_HISTORY_ROWS);
      expect(lines[0]).toContain(`step ${WALLET_HISTORY_ROWS + 4}`);
      expect(lines[0]).toContain('inference');
    });

    it('rejects an unknown action', async () => {
      expect((await run('wallet', { action: 'send' })).isError).toBe(true);
    });
  });
});

// The service market: publishing an endpoint, repricing it, browsing other agents' listings and
// paying for a call. SPEC §8.9; AMENDMENTS B19 (buyer pays only the price), C28 (`service` event).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ToolRegistry } from '../../src/core/interfaces.js';
import type { AgentRow } from '../../src/db/schema.js';
import { agents, services } from '../../src/db/schema.js';
import { createToolRegistry } from '../../src/tools/index.js';
import { MAX_SERVICES_PER_AGENT } from '../../src/tools/services.js';
import { ctxFor, execOpts, fakePorts, lockTestDb, seedAgent, testDbAvailable, testDeps, type FakePorts, type TestDb, type TestDeps } from './helpers/env.js';

const hasDb = await testDbAvailable();
const suite = hasDb ? describe : describe.skip;

suite('service tools', () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let ports: FakePorts;
  let registry: ToolRegistry;
  let seller: AgentRow;
  let buyer: AgentRow;

  const run = (agent: AgentRow, name: string, input: unknown) => registry.execute(ctxFor(agent), name, input, execOpts());
  const idOf = (content: string) => /\b(sv_[a-z0-9]{10})\b/.exec(content)?.[1] ?? '';

  async function publish(over: Record<string, unknown> = {}): Promise<string> {
    const res = await run(seller, 'create_service', {
      name: 'JSON Tidy', description: 'Send {"json":"..."} and get a formatted document back.',
      priceUsd: 0.05, handlerPath: 'svc/handler.js', ...over,
    });
    expect(res.isError).toBeUndefined();
    return idOf(res.content);
  }

  beforeAll(async () => { testDb = await lockTestDb(); });
  afterAll(async () => { await testDb.close(); });

  beforeEach(async () => {
    await testDb.reset();
    ports = fakePorts();
    deps = testDeps(testDb.db);
    registry = createToolRegistry(deps, ports);
    seller = await seedAgent(deps.db, deps.clock, { name: 'SELLER' });
    buyer = await seedAgent(deps.db, deps.clock, { name: 'BUYER', treasuryMicro: 1_000_000 });
    deps.sandbox.files.set('svc/handler.js', 'process.stdout.write("{}")');
  });


  describe('create_service', () => {
    it('publishes an endpoint at the API service URL', async () => {
      const res = await run(seller, 'create_service', {
        name: 'JSON Tidy', description: 'Send {"json":"..."} and get a formatted document back.',
        priceUsd: 0.05, handlerPath: './svc/handler.js',
      });

      const id = idOf(res.content);
      expect(res.content).toContain(`${deps.config.apiUrl}/svc/${id}`);
      expect(res.costMicro).toBe(0);
      expect(res.event).toMatchObject({ kind: 'service', amountMicro: 50_000 });

      const [row] = await deps.db.select().from(services).where(eq(services.id, id));
      expect(row).toMatchObject({ agentId: seller.id, priceMicro: 50_000, handlerPath: 'svc/handler.js', status: 'active' });
    });

    it('refuses a handler that does not exist yet', async () => {
      const res = await run(seller, 'create_service', {
        name: 'Ghost', description: 'A service whose handler was never written to disk.',
        priceUsd: 0.05, handlerPath: 'svc/missing.js',
      });
      expect(res.isError).toBe(true);
      expect(res.content).toContain('No readable handler');
      expect(await deps.db.select().from(services)).toHaveLength(0);
    });

    it('refuses a handler path that escapes /work', async () => {
      const res = await run(seller, 'create_service', {
        name: 'Escape', description: 'A service whose handler path tries to leave the sandbox.',
        priceUsd: 0.05, handlerPath: '../../etc/passwd',
      });
      expect(res.isError).toBe(true);
    });

    it('rejects prices outside the allowed band', async () => {
      const low = await run(seller, 'create_service', { name: 'Free', description: 'Priced below the protocol floor.', priceUsd: 0, handlerPath: 'svc/handler.js' });
      const high = await run(seller, 'create_service', { name: 'Huge', description: 'Priced above the protocol ceiling.', priceUsd: 1_000, handlerPath: 'svc/handler.js' });
      expect(low.isError).toBe(true);
      expect(high.isError).toBe(true);
    });

    it('caps the catalogue per agent', async () => {
      for (let i = 0; i < MAX_SERVICES_PER_AGENT; i++) await publish({ name: `Service ${i}` });
      const overflow = await run(seller, 'create_service', { name: 'One too many', description: 'The service that goes past the catalogue cap.', priceUsd: 0.05, handlerPath: 'svc/handler.js' });
      expect(overflow.isError).toBe(true);
      expect(overflow.content).toContain(`limit ${MAX_SERVICES_PER_AGENT}`);
    });

    it('refuses a duplicate name whatever its case', async () => {
      await publish({ name: 'JSON Tidy' });
      const dupe = await run(seller, 'create_service', { name: 'json tidy', description: 'Same name in another case entirely.', priceUsd: 0.05, handlerPath: 'svc/handler.js' });
      expect(dupe.isError).toBe(true);
      expect(dupe.content).toContain('already have a service');
    });
  });

  describe('update_service', () => {
    it('reprices and pauses the seller’s own service', async () => {
      const id = await publish();
      const repriced = await run(seller, 'update_service', { serviceId: id, priceUsd: 0.25, status: 'paused' });
      expect(repriced.content).toContain('paused');

      const [row] = await deps.db.select().from(services).where(eq(services.id, id));
      expect(row!.priceMicro).toBe(250_000);
      expect(row!.status).toBe('paused');
    });

    it('refuses another agent’s service and a no-op call', async () => {
      const id = await publish();
      expect((await run(buyer, 'update_service', { serviceId: id, status: 'paused' })).content).toContain('your own services');
      expect((await run(seller, 'update_service', { serviceId: id, status: null, priceUsd: null })).isError).toBe(true);
    });
  });

  describe('list_services', () => {
    it('lists other agents’ active services as untrusted data', async () => {
      const id = await publish();
      const res = await run(buyer, 'list_services', {});
      expect(res.content).toMatch(/^<untrusted source="list_services \(other agents\)">/);
      expect(res.content).toContain(id);
      expect(res.content).toContain('SELLER');
    });

    it('hides the caller’s own and paused services', async () => {
      const id = await publish();
      expect((await run(seller, 'list_services', {})).content).toContain('No other agent is selling');

      await run(seller, 'update_service', { serviceId: id, status: 'paused' });
      expect((await run(buyer, 'list_services', {})).content).toContain('No other agent is selling');
    });
  });

  describe('call_service', () => {
    it('runs the handler and pays the seller the listed price', async () => {
      const id = await publish();
      const res = await run(buyer, 'call_service', { serviceId: id, input: '{"json":"{}"}' });

      expect(res.isError).toBeUndefined();
      expect(res.costMicro).toBe(50_000);
      expect(res.ledgerKind).toBe('payment');
      expect(ports.invoker.calls).toEqual([{ serviceId: id, agentId: buyer.id, input: { json: '{}' } }]);
      expect(ports.payments.transfers).toEqual([
        { agentId: buyer.id, to: seller.walletPubkey, amountMicro: 50_000, memo: expect.stringContaining('JSON Tidy') },
      ]);
      expect(res.content).toContain('<untrusted source="call_service JSON Tidy by SELLER">');
      expect(res.event).toMatchObject({ kind: 'service', amountMicro: 50_000 });
    });

    it('sends non-JSON input as a JSON string rather than refusing it', async () => {
      const id = await publish();
      await run(buyer, 'call_service', { serviceId: id, input: 'just some prose' });
      expect(ports.invoker.calls[0]?.input).toBe('just some prose');
    });

    it('charges nothing when the handler fails or times out', async () => {
      const id = await publish();
      ports.invoker.result = { callId: 7, status: 'error', output: { error: 'handler exited with code 1' }, cpuMs: 30 };
      const res = await run(buyer, 'call_service', { serviceId: id, input: '{}' });

      expect(res.isError).toBe(true);
      expect(res.costMicro).toBe(0);
      expect(res.content).toContain('not charged');
      expect(ports.payments.transfers).toHaveLength(0);
    });

    it('refuses to buy from yourself, from a paused service or beyond your treasury', async () => {
      const id = await publish();
      expect((await run(seller, 'call_service', { serviceId: id, input: '{}' })).content).toContain('your own service');

      await run(seller, 'update_service', { serviceId: id, priceUsd: 5 });
      const broke = await run(buyer, 'call_service', { serviceId: id, input: '{}' });
      expect(broke.isError).toBe(true);
      expect(broke.content).toContain('your treasury is');

      await run(seller, 'update_service', { serviceId: id, status: 'paused', priceUsd: 0.05 });
      expect((await run(buyer, 'call_service', { serviceId: id, input: '{}' })).content).toContain('paused by its seller');
      expect(ports.invoker.calls).toHaveLength(0);
    });

    it('refuses a dead seller and an unknown id', async () => {
      const id = await publish();
      await deps.db.update(agents).set({ status: 'dead' }).where(eq(agents.id, seller.id));
      const dead = await run(buyer, 'call_service', { serviceId: id, input: '{}' });
      expect(dead.isError).toBe(true);
      expect(dead.content).toContain('is dead');

      const missing = await run(buyer, 'call_service', { serviceId: 'sv_nosuchsvc1', input: '{}' });
      expect(missing.content).toContain('No service');
      expect(ports.invoker.calls).toHaveLength(0);
    });
  });
});

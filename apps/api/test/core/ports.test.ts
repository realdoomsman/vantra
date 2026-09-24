// The composition root's adapter between tools/ports.ts:InternalServiceInvoker and hosting's runner:
// it records the `service_calls` row that the call_service tool needs an id for.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serviceCalls, services } from '../../src/db/schema.js';
import { toolPorts } from '../../src/core/ports.js';
import { createHarness, type Harness } from '../economy/helpers/harness.js';

describe('core/ports internal service invoker', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  const seedService = async (priceMicro = 50_000) => {
    const seller = await h.seedAgent({ name: 'SELLER' });
    await h.db.insert(services).values({
      id: 'sv_handler001', agentId: seller.id, name: 'Word Count', description: 'counts words',
      priceMicro, handlerPath: 'handler.js', status: 'active', createdAt: h.clock.now(),
    });
    return seller;
  };

  it('runs the handler, charges the seller compute and records a priced call', async () => {
    const seller = await seedService();
    const buyer = await h.seedAgent({ name: 'BUYER' });
    h.sandbox.nextExec = { stdout: '{"words":3}', stderr: '', exitCode: 0, cpuMs: 20, timedOut: false };

    const result = await toolPorts(h.deps).invoker.invoke('sv_handler001', buyer.id, { text: 'one two three' });

    expect(result).toMatchObject({ status: 'ok', output: { words: 3 }, cpuMs: 20 });
    const [call] = await h.db.select().from(serviceCalls).where(eq(serviceCalls.id, result.callId));
    expect(call).toMatchObject({ buyerType: 'agent', buyerId: buyer.id, priceMicro: 50_000, status: 'ok' });
    const [row] = await h.db.select().from(services).where(eq(services.id, 'sv_handler001'));
    expect(row).toMatchObject({ calls: 1, revenueMicro: 50_000 });
    expect((await h.reload(seller.id)).spendComputeMicro).toBeGreaterThan(0);
  });

  it('records a failed handler run at price zero: the buyer is never charged for it', async () => {
    await seedService();
    const buyer = await h.seedAgent({ name: 'BUYER' });
    h.sandbox.nextExec = { stdout: '', stderr: 'boom', exitCode: 1, cpuMs: 5, timedOut: false };

    const result = await toolPorts(h.deps).invoker.invoke('sv_handler001', buyer.id, {});

    expect(result.status).toBe('error');
    const [call] = await h.db.select().from(serviceCalls).where(eq(serviceCalls.id, result.callId));
    expect(call!.priceMicro).toBe(0);
    const [row] = await h.db.select().from(services).where(eq(services.id, 'sv_handler001'));
    expect(row).toMatchObject({ calls: 1, revenueMicro: 0 });
  });

  it('reports an unknown service as a 404 rather than crashing the step', async () => {
    await expect(toolPorts(h.deps).invoker.invoke('sv_nosuchsvc0', 'ag_x', {})).rejects.toThrow('not found');
  });
});

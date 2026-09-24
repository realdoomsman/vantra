// SPEC §7 invariant: treasury_micro always equals balance_after_micro of the latest ledger row, and
// nothing but ledger.post moves the money columns.
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ledger } from '../../src/db/schema.js';
import { post, postSettlement, profitOf } from '../../src/economy/ledger.js';
import { createHarness, type Harness } from './helpers/harness.js';

describe('economy/ledger', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  it('keeps treasury equal to the latest balance_after across a sequence of posts', async () => {
    const agent = await h.seedAgent({ treasuryMicro: 10_000_000 });
    const amounts = [-20_000, 5_000_000, -1_234, -500_000, 99];
    for (const amountMicro of amounts) {
      await post(h.deps, h.db, { agentId: agent.id, kind: amountMicro < 0 ? 'tool' : 'revenue_external', amountMicro, memo: 'seq' });
    }
    const rows = await h.db.select().from(ledger).where(eq(ledger.agentId, agent.id)).orderBy(asc(ledger.id));
    const final = await h.reload(agent.id);
    expect(rows.map((r) => r.balanceAfterMicro)).toEqual([9_980_000, 14_980_000, 14_978_766, 14_478_766, 14_478_865]);
    expect(final.treasuryMicro).toBe(rows.at(-1)!.balanceAfterMicro);
  });

  it('routes each kind to its aggregate and accrues protocol spend as unsettled', async () => {
    const agent = await h.seedAgent({ treasuryMicro: 10_000_000, fundingMicro: 0 });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'inference', amountMicro: -30_000, memo: 'm' });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'rent', amountMicro: -20_000, memo: 'm' });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'tool', amountMicro: -5_000, memo: 'm' });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'hosting', amountMicro: -1_000, memo: 'm' });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'gas', amountMicro: -7_000, memo: 'm' });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'compute', amountMicro: -2_000, memo: 'm' });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'revenue_external', amountMicro: 4_000_000, memo: 'm' });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'revenue_internal', amountMicro: 1_000_000, memo: 'm' });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'payment', amountMicro: -250_000, memo: 'm' });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'escrow_out', amountMicro: -100_000, memo: 'm' });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'refund', amountMicro: 100_000, memo: 'm' });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'royalty_out', amountMicro: -200_000, memo: 'm' });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'royalty_in', amountMicro: 300_000, memo: 'm' });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'recapitalize', amountMicro: 2_000_000, memo: 'm' });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'withdrawal', amountMicro: -400_000, memo: 'm' });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'withdrawal_fee', amountMicro: -10_000, memo: 'm' });

    const row = await h.reload(agent.id);
    expect(row.spendInferenceMicro).toBe(30_000);
    expect(row.spendRentMicro).toBe(20_000);
    expect(row.spendToolsMicro).toBe(5_000);
    expect(row.spendHostingMicro).toBe(1_000);
    expect(row.spendGasMicro).toBe(7_000);
    expect(row.spendComputeMicro).toBe(2_000);
    expect(row.revenueExternalMicro).toBe(4_000_000);
    expect(row.revenueInternalMicro).toBe(1_000_000);
    expect(row.spendPaymentsMicro).toBe(250_000);          // payment + escrow_out − refund
    expect(row.royaltyOutMicro).toBe(200_000);
    expect(row.royaltyInMicro).toBe(300_000);
    expect(row.recapitalizedMicro).toBe(2_000_000);
    expect(row.withdrawnMicro).toBe(400_000);
    // only protocol spend is owed on chain
    expect(row.unsettledMicro).toBe(30_000 + 20_000 + 5_000 + 1_000 + 7_000 + 2_000);
    expect(profitOf(row)).toBe(4_000_000 + 1_000_000 + 300_000 - (30_000 + 2_000 + 20_000 + 5_000 + 1_000 + 7_000 + 250_000 + 200_000));
  });

  it('classifies escrow_in by the poster of the bounty', async () => {
    const agent = await h.seedAgent();
    await post(h.deps, h.db, { agentId: agent.id, kind: 'escrow_in', amountMicro: 500_000, memo: 'user bounty', meta: { revenueClass: 'external' } });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'escrow_in', amountMicro: 200_000, memo: 'agent bounty', meta: { revenueClass: 'internal' } });
    const row = await h.reload(agent.id);
    expect(row.revenueExternalMicro).toBe(500_000);
    expect(row.revenueInternalMicro).toBe(200_000);
  });

  it('broadcasts a ledger entry and an agent money patch for every post', async () => {
    const agent = await h.seedAgent();
    h.messages.length = 0;
    await post(h.deps, h.db, { agentId: agent.id, kind: 'inference', amountMicro: -12_345, memo: 'step 1' });
    const entry = h.messages.find((m) => m.type === 'ledger');
    const patch = h.messages.find((m) => m.type === 'agent');
    expect(entry).toMatchObject({ type: 'ledger', entry: { amountMicro: -12_345, kind: 'inference', balanceAfterMicro: 9_987_655 } });
    expect(patch).toMatchObject({ type: 'agent', agentId: agent.id, patch: { treasuryMicro: 9_987_655, unsettledMicro: 12_345 } });
  });

  it('settlement clears unsettled, marks the swept rows and leaves the treasury alone', async () => {
    const agent = await h.seedAgent();
    await post(h.deps, h.db, { agentId: agent.id, kind: 'inference', amountMicro: -40_000, memo: 'a' });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'rent', amountMicro: -20_000, memo: 'b' });
    const before = await h.reload(agent.id);
    expect(before.unsettledMicro).toBe(60_000);

    const { agent: after } = await postSettlement(h.deps, h.db, {
      agentId: agent.id, sweptMicro: 60_000, txSig: 'sig-settle', counterparty: 'protocol-fee-wallet',
    });
    expect(after.unsettledMicro).toBe(0);
    expect(after.treasuryMicro).toBe(before.treasuryMicro);

    const rows = await h.db.select().from(ledger).where(eq(ledger.agentId, agent.id)).orderBy(asc(ledger.id));
    expect(rows.filter((r) => r.kind === 'inference' || r.kind === 'rent').every((r) => r.settled)).toBe(true);
    expect(rows.at(-1)).toMatchObject({ kind: 'settlement', amountMicro: 0, txSig: 'sig-settle' });
    expect(rows.at(-1)!.meta).toMatchObject({ sweptMicro: 60_000 });
  });
});

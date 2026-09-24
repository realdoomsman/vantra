// x402 economy contract: when a completion is paid on-chain from the agent's own wallet, the step
// books it as `inference_paid` — settled on arrival, carrying the settlement tx hash, and NEVER
// accrued to unsettled_micro (there is nothing for the hourly sweep to move; the money already left).
// This is the one behaviour that separates x402 from the metered-and-swept default.
import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ledger } from '../../src/db/schema.js';
import type { LlmResponse } from '../../src/core/interfaces.js';
import { runStep } from '../../src/runtime/step.js';
import { fakeLlm, type FakeLlm } from '../economy/helpers/fakes.js';
import { createHarness, type Harness } from '../economy/helpers/harness.js';

const PAID_MICRO = 500;

// Wraps the scripted mock so EVERY completion arrives already paid on-chain, as the real x402 provider
// would surface it: a fixed cost and a settlement receipt with a unique tx hash per call.
function paidLlm(): FakeLlm {
  const base = fakeLlm();
  let n = 0;
  return {
    ...base,
    async complete(req) {
      const res = await base.complete(req);
      n += 1;
      const paid: LlmResponse = {
        ...res,
        usage: { ...res.usage, costMicro: PAID_MICRO },
        payment: { txSig: `0x${String(n).padStart(64, '0')}`, network: 'eip155:4663', payTo: null, amountMicro: PAID_MICRO },
      };
      return paid;
    },
  };
}

describe('runtime/step x402 inference', () => {
  let h: Harness;
  afterEach(async () => { await h.close(); });

  it('books x402-paid inference as inference_paid: settled, signed, and never swept', async () => {
    h = await createHarness({ llm: paidLlm() });
    const agent = await h.seedAgent({ treasuryMicro: 10_000_000 });

    const outcome = await runStep(h.deps, agent);
    expect(outcome.status).toBe('ok');

    const rows = await h.db.select().from(ledger).where(eq(ledger.agentId, agent.id)).orderBy(asc(ledger.id));
    const paid = rows.filter((r) => r.kind === 'inference_paid');

    // Every inference charge this step is the on-chain kind, none of the swept kind.
    expect(paid.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.kind === 'inference')).toBe(false);
    for (const r of paid) {
      expect(r.settled).toBe(true);                       // paid on arrival — nothing owed to the protocol
      expect(r.txSig).toMatch(/^0x[0-9a-f]{64}$/);         // the settlement tx hash is recorded
      expect(r.amountMicro).toBe(-PAID_MICRO);
    }

    // unsettled_micro is the protocol's IOU. Genuinely-owed spend (rent, tools…) accrues there;
    // x402-paid inference must NOT — so unsettled equals only the non-x402 protocol spend.
    const OWED_KINDS: Record<string, true> = { inference: true, compute: true, rent: true, tool: true, hosting: true, gas: true };
    const owed = rows.filter((r) => OWED_KINDS[r.kind]).reduce((s, r) => s + Math.abs(r.amountMicro), 0);
    const after = await h.reload(agent.id);
    expect(after.unsettledMicro).toBe(owed);

    // The treasury dropped by the real amount paid to the gateway (plus any rent), never by less.
    expect(after.treasuryMicro).toBeLessThanOrEqual(10_000_000 - paid.length * PAID_MICRO);
  });
});

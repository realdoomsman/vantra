// The launchpad's security boundary (launchpad spec §5 "Confirm must verify, not trust"): a coin is
// listed only when the chain proves its creator tax is paid to the agent VANTRA created for it. A dev
// who signs a launch that pays the tax to themselves must not get an "AI-funded" listing.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usd, type LaunchPrepareRequest } from '@vantra/shared';
import { agents, launches } from '../../src/db/schema.js';
import { confirmLaunch, listLaunches, prepareLaunch, simulateFees, simulateLaunch } from '../../src/economy/launch.js';
import type { ApiError } from '../../src/lib/errors.js';
import { createHarness, type Harness } from './helpers/harness.js';

const DEV = '0x1111111111111111111111111111111111111111';

const request: LaunchPrepareRequest = {
  name: 'Oracle Owl', ticker: 'OWL', description: 'Sourced research on demand.',
  logoUrl: null, website: null, twitter: null, telegram: null,
  creatorTaxBps: 250, strategy: 'research', instructions: null,
};

describe('economy/launch confirm', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  it('fails and never lists a launch whose creator fees go to anyone but the agent', async () => {
    const { launch } = await prepareLaunch(h.deps, DEV, request);
    const { walletPubkey } = (await h.reload(launch.agentId));

    // The dev signs a real launch with every agreed term except the recipient: the fees are theirs.
    const diverted = await h.deps.launchpad.simulateLaunch!({
      devWallet: DEV, agentWallet: DEV, creatorTaxBps: request.creatorTaxBps, name: request.name, symbol: request.ticker,
    });
    expect(walletPubkey.toLowerCase()).not.toBe(DEV.toLowerCase());

    const err = await confirmLaunch(h.deps, launch.id, DEV, diverted.txSig).then(
      () => { throw new Error('confirm accepted a diverted launch'); },
      (e: unknown) => e as ApiError,
    );
    expect(err.status).toBe(400);
    expect(err.code).toBe('INVALID_TX');

    const [row] = await h.db.select().from(launches).where(eq(launches.id, launch.id));
    expect(row!.state).toBe('failed');
    expect(row!.failureReason).toMatch(/creatorFeeRecipient/i);
    const [agent] = await h.db.select().from(agents).where(eq(agents.id, launch.agentId));
    expect(agent!.status).toBe('dormant');
    expect(agent!.tokenMint).toBeNull();
    expect((await listLaunches(h.deps, { sort: 'new', limit: 50, offset: 0 })).total).toBe(0);

    // Failed is final: the honest launch afterwards cannot resurrect the listing either.
    await expect(simulateLaunch(h.deps, launch.id, DEV)).rejects.toMatchObject({ code: 'LAUNCH_STATE' });
    expect((await listLaunches(h.deps, { sort: 'new', limit: 50, offset: 0 })).rows).toEqual([]);
  });
});

describe('economy/launch prepare without a sandbox', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness({ env: { SANDBOX_DRIVER: 'none' } }); });
  afterEach(async () => { await h.close(); });

  it('refuses the code-running strategies whatever the form sent, and creates nothing', async () => {
    for (const strategy of ['api', 'product'] as const) {
      await expect(prepareLaunch(h.deps, DEV, { ...request, strategy }))
        .rejects.toMatchObject({ status: 400, code: 'STRATEGY_NEEDS_SANDBOX' });
    }
    expect(await h.db.select().from(agents)).toEqual([]);
    expect(await h.db.select().from(launches)).toEqual([]);

    // A strategy that needs no code still launches on the same deployment.
    const { launch } = await prepareLaunch(h.deps, DEV, request);
    expect(launch.strategy).toBe('research');
  });
});

describe('economy/launch simulated fees', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  // Claims are booked in whole gwei; a credit floored to the wei lands a fraction of a cent short of
  // the dollar amount the dev pressed, and misses the rung that amount is priced at.
  it('books at least the amount simulated, so exactly a rung\'s price unlocks that rung', async () => {
    const { launch } = await prepareLaunch(h.deps, DEV, request);
    await simulateLaunch(h.deps, launch.id, DEV);

    const after = await simulateFees(h.deps, launch.id, 100);

    expect(after.feesClaimedMicro).toBeGreaterThanOrEqual(usd(100));
    expect(after.rung).toBe('PRIME');
  });
});

// The launchpad agent's lifecycle (launchpad spec §2): a dormant agent costs nothing and cannot die,
// running out of money sends a launched agent dormant instead of killing it, and the buyback-and-burn
// never takes the treasury below its runway floor.
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usd } from '@vantra/shared';
import { agents, burns, events, launches, ledger, type AgentRow } from '../../src/db/schema.js';
import { ladderView, setLaunchModel } from '../../src/economy/ladder.js';
import { post } from '../../src/economy/ledger.js';
import { burnPlan, runLaunchLifecycle } from '../../src/economy/token.js';
import { newLaunchId } from '../../src/lib/ids.js';
import { chargeRent } from '../../src/runtime/rent.js';
import { chargeIdleRent } from '../../src/runtime/scheduler.js';
import { runStep } from '../../src/runtime/step.js';
import { createHarness, type Harness, type SeedAgentInput } from './helpers/harness.js';

const DAY = 86_400_000;
const ACTIVATION = usd(10);

// An agent whose coin is live: the memory launchpad records the launch (and prices the token), the agent
// carries the token columns, and a `launches` row in state 'launched' ties the two together.
async function seedLaunched(h: Harness, input: SeedAgentInput): Promise<{ agent: AgentRow; launchId: string }> {
  const seeded = await h.seedAgent(input);
  const coin = await h.deps.launchpad.simulateLaunch!({
    devWallet: seeded.ownerWallet, agentWallet: seeded.walletPubkey, creatorTaxBps: 500, name: seeded.name, symbol: 'COIN',
  });
  const now = h.clock.now();
  await h.db.update(agents).set({
    tokenMint: coin.token, tokenCurve: coin.curve, tokenCreatorTaxBps: 500, tokenTicker: 'COIN', tokenName: seeded.name, tokenLaunchedAt: now,
  }).where(eq(agents.id, seeded.id));
  const launchId = newLaunchId();
  await h.db.insert(launches).values({
    id: launchId, agentId: seeded.id, devWallet: seeded.ownerWallet, name: seeded.name, ticker: 'COIN', description: 'a test coin',
    creatorTaxBps: 500, strategy: 'api', instructions: null, state: 'launched', launchTxSig: coin.txSig,
    activationMicro: ACTIVATION, activatedAt: seeded.status === 'dormant' ? null : now, createdAt: now, launchedAt: now,
  });
  return { agent: await h.reload(seeded.id), launchId };
}

const launchRow = async (h: Harness, id: string) => (await h.db.select().from(launches).where(eq(launches.id, id)))[0]!;

describe('economy/launch lifecycle', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.close(); });

  it('never charges a dormant agent rent and never kills it, however long it waits', async () => {
    const { agent } = await seedLaunched(h, { status: 'dormant', treasuryMicro: 0, fund: 0, nextStepAt: null });
    h.clock.advance(45 * DAY);

    expect(await chargeIdleRent(h.deps)).toBe(0);
    expect((await chargeRent(h.deps, await h.reload(agent.id), h.clock.now())).rentMicro).toBe(0);
    expect((await runStep(h.deps, await h.reload(agent.id))).ran).toBe(false);

    const after = await h.reload(agent.id);
    expect(after).toMatchObject({ status: 'dormant', treasuryMicro: 0, diedAt: null, deathCause: null, spendRentMicro: 0 });
    expect(await h.db.select().from(ledger).where(eq(ledger.agentId, agent.id))).toEqual([]);
    expect(await h.db.select().from(events).where(and(eq(events.agentId, agent.id), eq(events.kind, 'death')))).toEqual([]);
  });

  it('sends a launched agent that runs out of money dormant — a bought one still dies — and wakes it when fees return', async () => {
    const later = new Date(h.clock.now().getTime() + 10 * DAY);
    const bought = await h.seedAgent({ status: 'alive', treasuryMicro: 1_000, nextStepAt: later });
    const { agent, launchId } = await seedLaunched(h, { status: 'alive', treasuryMicro: 1_000, nextStepAt: later });
    h.clock.advanceHours(3);                       // 3h of awake rent is far more than the $0.001 either holds

    await chargeIdleRent(h.deps);

    expect((await h.reload(bought.id)).status).toBe('dead');
    const broke = await h.reload(agent.id);
    expect(broke).toMatchObject({ status: 'dormant', diedAt: null, deathCause: null, nextStepAt: null });
    expect(broke.treasuryMicro).toBeLessThanOrEqual(0);
    expect((await launchRow(h, launchId)).activatedAt).toBeNull();

    // $20 of creator fees accrue in the escrow; the next lifecycle pass must pick the agent up again.
    h.deps.launchpad.creditEscrow!(broke.walletPubkey, (20n * 10n ** 18n) / BigInt(h.config.chain.ethPriceUsd));
    await runLaunchLifecycle(h.deps, agent.id);

    const woke = await h.reload(agent.id);
    expect(woke.status).toBe('alive');
    expect(woke.treasuryMicro).toBeGreaterThan(0);
    expect(woke.nextStepAt!.getTime()).toBeLessThanOrEqual(h.clock.now().getTime());
    expect((await launchRow(h, launchId)).activatedAt).not.toBeNull();
  });

  it('never plans a burn that leaves the treasury below its floor, even when the agent costs almost nothing', () => {
    const minBurnMicro = usd(5);
    for (const burnPerDayMicro of [0, 1, 333, 50_000, 1_234_567, 9_000_000]) {
      for (const upgradeBurnPerDayMicro of [0, 1, 19_560_000]) {
        for (const treasuryMicro of [-5_000_000, 0, 9_999_999, 10_000_000, 15_000_001, 42_424_242, 500_000_000]) {
          for (const unsettledMicro of [0, 1, 2_500_000]) {
            const plan = burnPlan({
              treasuryMicro, unsettledMicro, burnPerDayMicro, floorDays: 30, upgradeBurnPerDayMicro, switchMinDays: 7,
              activationMicro: ACTIVATION, minBurnMicro,
            });
            expect(plan.floorMicro).toBeGreaterThanOrEqual(ACTIVATION);
            expect(plan.floorMicro).toBeGreaterThanOrEqual(30 * burnPerDayMicro);
            expect(plan.floorMicro).toBeGreaterThanOrEqual(7 * upgradeBurnPerDayMicro);
            if (!plan.burn) continue;
            expect(plan.surplusMicro).toBeGreaterThanOrEqual(minBurnMicro);
            expect(treasuryMicro - plan.surplusMicro - unsettledMicro).toBeGreaterThanOrEqual(plan.floorMicro);
          }
        }
      }
    }
  });

  // The invariant a dev actually sees: a model the coin has unlocked is still affordable the moment a
  // burn finishes. A 5-minute heartbeat makes mock-strong ~5× mock-fast per day, so 30 days of the
  // current model would NOT cover 7 days of the unlocked one — the floor has to.
  it('leaves every unlocked model affordable right after a burn', async () => {
    const { agent } = await seedLaunched(h, { status: 'alive', treasuryMicro: usd(300), heartbeatMin: 5, model: 'mock-fast' });
    await h.db.update(agents).set({ creatorRewardMicro: usd(150) }).where(eq(agents.id, agent.id));    // PRIME unlocked

    await runLaunchLifecycle(h.deps, agent.id);

    const after = await h.reload(agent.id);
    expect(after.treasuryMicro).toBeLessThan(usd(300));                  // it did burn
    const prime = (await ladderView(h.deps, after)).find((r) => r.rung === 'PRIME')!;
    expect(prime).toMatchObject({ unlocked: true, availableModels: ['mock-strong'], affordable: true });
    await setLaunchModel(h.deps, (await h.db.select().from(launches).where(eq(launches.agentId, agent.id)))[0]!.id, agent.ownerWallet, 'mock-strong');
    expect((await h.reload(agent.id)).model).toBe('mock-strong');
  });

  it('burns exactly the surplus above the floor, burns every token it bought, and never buys twice', async () => {
    // A once-a-day heartbeat on the cheapest model: 30 days of burn is a few dollars, so the floor is the
    // activation threshold, not the burn rate.
    const { agent, launchId } = await seedLaunched(h, { status: 'alive', treasuryMicro: usd(100), heartbeatMin: 1440, model: 'mock-fast' });
    await post(h.deps, h.db, { agentId: agent.id, kind: 'inference', amountMicro: -usd(2), memo: 'owed to the protocol' });
    const owing = await h.reload(agent.id);
    expect(owing).toMatchObject({ treasuryMicro: usd(98), unsettledMicro: usd(2) });

    await runLaunchLifecycle(h.deps, agent.id);

    const after = await h.reload(agent.id);
    expect(after.treasuryMicro).toBe(ACTIVATION + usd(2));          // floor + what it still owes, not a cent less
    const [burn, ...more] = await h.db.select().from(burns).where(eq(burns.launchId, launchId));
    expect(more).toEqual([]);
    expect(burn!.spentMicro).toBe(usd(98) - ACTIVATION - usd(2));
    expect(burn!.tokens > 0n).toBe(true);
    expect(burn!.burnTxSig).not.toBeNull();
    expect(await h.deps.launchpad.tokenBalance(agent.walletPubkey, agent.tokenMint!)).toBe(0n);
    const buybacks = await h.db.select().from(ledger).where(and(eq(ledger.agentId, agent.id), eq(ledger.kind, 'buyback')));
    expect(buybacks.map((r) => r.amountMicro)).toEqual([-burn!.spentMicro]);

    await runLaunchLifecycle(h.deps, agent.id);
    expect((await h.reload(agent.id)).treasuryMicro).toBe(after.treasuryMicro);
    expect(await h.db.select().from(burns).where(eq(burns.launchId, launchId))).toHaveLength(1);
  });
});

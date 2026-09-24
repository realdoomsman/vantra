// The demo colony (SPEC §8.18): DEMO_AGENTS agents born across the last DEMO_DAYS days, driven by
// the REAL step loop on a fast-forward clock with the mock provider, the memory chain and the local
// sandbox. Nothing here is a shortcut around the runtime — the simulator only plays the parts of the
// world that are outside it: the calendar, paying customers, the operator who reviews VANTRA's
// own bounties, and the devs and traders behind the launchpad's coins (sim/launches.ts). When the
// window closes the clock is released and the live scheduler takes over.
import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { DAY_MS, FOUNDER_FEE_BPS_DEFAULT, HOUR_MS, MINUTE_MS, bpsOf, fmtUsd, makeRng, usd } from '@vantra/shared';
import type { Deps } from '../core/interfaces.js';
import { agents, burns, launches } from '../db/schema.js';
import { dueCondition } from '../economy/agents.js';
import { expireBounties } from '../economy/market.js';
import { runCreatorFees } from '../economy/token.js';
import { treasuryService } from '../economy/treasury.js';
import { FastClock } from '../lib/clock.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/log.js';
import { runSettlement } from '../runtime/settlement.js';
import { colonyCast, type ColonyMember } from './colony.js';
import { LAUNCH_WINDOW_DAYS, launchSeeder, type LaunchSeeder } from './launches.js';
import { postFinalBoard, postProtocolBounty, protocolBountyAt, reviewProtocolSubmissions } from './market.js';
import { runDemand } from './revenue.js';

export const TICK_HOURS = 12;                  // virtual hours per tick: two heartbeats a day per agent
const BOUNTY_EVERY_TICKS = 5;                  // VANTRA posts a job every ~2.5 simulated days
const FORK_AT_FRACTION = 0.7;                  // when in the window the colony's first fork appears
const HANDOVER_MIN_DELAY_MS = 90_000;          // shortest handover window, for an unusually fast heartbeat
const BOUNTY_DEADLINE_HOURS = 96;
const PROGRESS_EVERY_TICKS = 8;
const FORK_CHILD_ID = 'ag_fork000001';         // fixed so the fork's mock persona is seeded like the rest

export async function runDemo(deps: Deps): Promise<void> {
  const log = deps.log.child({ mod: 'sim' });
  const clock = deps.clock;
  if (!(clock instanceof FastClock)) throw new Error('sim: the demo needs the FastClock (set DEMO=1)');
  if (deps.chain.mode !== 'memory') throw new Error('sim: the demo needs CHAIN_MODE=memory');

  const existing = await deps.db.select({ id: agents.id }).from(agents).limit(1);
  if (existing.length > 0) {
    // A colony from before the launchpad existed still gets its coins, fast-forwarded on their own.
    const [anyLaunch] = await deps.db.select({ id: launches.id }).from(launches).limit(1);
    if (!anyLaunch) {
      log.warn('a colony is already in this database; seeding only the launchpad before running it live');
      await seedLaunchpadAlone(deps, clock, log);   // releases the clock
      return;
    }
    log.warn('a colony is already in this database; skipping the seed and running it live (drop the database to reseed)');
    clock.release();
    return;
  }

  const { seed, agents: count, days } = deps.config.demo;
  const rng = makeRng(seed);
  const endAt = new Date();
  const startAt = new Date(endAt.getTime() - days * DAY_MS);
  const cast = colonyCast({ count, seed, days, endAt });
  const tickMs = TICK_HOURS * HOUR_MS;
  const ticks = Math.ceil((endAt.getTime() - startAt.getTime()) / tickMs);

  clock.set(startAt);
  // v2 has no creator-fee pool: the treasury only ever holds money someone paid for an agent. The
  // colony is furniture, so it buys its float once, up front, and books a purchase per member
  // (SPEC-V2 §7.8) — the Treasury panel then tells a coherent story instead of an invented one.
  await fundDemoTreasury(deps, log);
  log.info({ agents: cast.length, days, ticks, from: startAt.toISOString() }, 'fast-forwarding the colony');

  const startedMs = Date.now();
  const births = birthQueue(deps, cast, log);
  const coins = launchSeeder(deps, clock, { endAt, seed }, log);
  let steps = 0;
  // The colony's first fork needs somebody to have published a strategy worth copying, and under v2
  // rates that happens late and unevenly. So this is "at or after FORK_AT_FRACTION of the window",
  // retried each tick until one takes, rather than a single attempt at an exact tick that usually
  // found nothing to fork and left the lineage panels empty.
  const forkAtTick = Math.floor(ticks * FORK_AT_FRACTION);
  let forked = false;
  for (let tick = 0; tick <= ticks; tick++) {
    const now = new Date(Math.min(endAt.getTime(), startAt.getTime() + tick * tickMs));
    clock.set(now);

    await births.upTo(now);
    await coins.upTo(now);
    if (tick % BOUNTY_EVERY_TICKS === 0) {
      await postProtocolBounty(deps, protocolBountyAt(tick / BOUNTY_EVERY_TICKS), BOUNTY_DEADLINE_HOURS)
        .catch((e: unknown) => log.warn({ err: errorMessage(e) }, 'protocol bounty failed'));
    }
    await runDemand(deps, rng);
    steps += await stepDueAgents(deps, now, log);
    await reviewProtocolSubmissions(deps, rng);
    await expireBounties(deps);
    await runSettlement(deps).catch((e: unknown) => log.warn({ err: errorMessage(e) }, 'settlement failed'));
    await treasuryService(deps).sync();
    await payCreatorFees(deps, coins, now, log);
    if (!forked && tick >= forkAtTick) forked = await forkBestStrategy(deps, log);

    if (tick % PROGRESS_EVERY_TICKS === 0 || tick === ticks) {
      log.info({ day: Math.round((tick * TICK_HOURS) / 24), born: births.born, steps, ...(await statusCounts(deps)) }, 'colony progress');
    }
  }

  await shareStrategies(deps);
  await postFinalBoard(deps, rng);
  const summary = await statusCounts(deps);
  clock.release();
  const restarts = await handOverToRealTime(deps);
  const pending = await seedPendingPurchases(deps, log);
  log.info(
    {
      ...summary, ...(await launchCounts(deps)), steps, seconds: Math.round((Date.now() - startedMs) / 1000), restarts,
      pendingPurchases: pending,
    },
    'demo colony ready; the live scheduler has it now',
  );
}

// Walks the (birth-ordered) cast once. A failed spawn is logged and skipped: one bad agent must not
// take the colony down.
function birthQueue(deps: Deps, cast: readonly ColonyMember[], log: Logger) {
  let next = 0;
  let born = 0;
  return {
    get born() { return born; },
    async upTo(now: Date): Promise<void> {
      while (next < cast.length && cast[next]!.bornAt <= now) {
        const member = cast[next++]!;
        try {
          await recordDemoSale(deps, member);
          await deps.services!.spawn(member.spawn);
          born += 1;
        } catch (e) {
          log.warn({ err: errorMessage(e), name: member.spawn.name }, 'demo spawn failed');
        }
      }
    },
  };
}

// One heartbeat for every agent the scheduler would have picked up, in birth order so the colony
// replays identically on the same seed. `only` narrows it to those agents.
async function stepDueAgents(deps: Deps, now: Date, log: Logger, only?: readonly string[]): Promise<number> {
  if (only && only.length === 0) return 0;
  const due = await deps.db.select({ id: agents.id }).from(agents)
    .where(only ? and(dueCondition(now), inArray(agents.id, [...only])) : dueCondition(now))
    .orderBy(asc(agents.bornAt)).limit(500);
  let ran = 0;
  for (const row of due) {
    try {
      await deps.runtime!.runStep(row.id);
      ran += 1;
    } catch (e) {
      log.warn({ err: errorMessage(e), agentId: row.id }, 'demo step failed');
    }
  }
  return ran;
}

// The traders pay every launched coin's creator tax for the tick just gone into the fee escrow; then
// Lifecycle's real `creator_fees` job claims, activates, climbs the ladder and burns, as it does live.
async function payCreatorFees(deps: Deps, coins: LaunchSeeder, now: Date, log: Logger): Promise<void> {
  await coins.accrue(now);
  await runCreatorFees(deps).catch((e: unknown) => log.warn({ err: errorMessage(e) }, 'creator fees job failed'));
}

// A colony seeded before the launchpad existed still gets its coins. They are fast-forwarded on their
// own over the last LAUNCH_WINDOW_DAYS, stepping only their agents — the colony is already live on
// its real-time schedule and is left exactly as it was — and then handed to the live scheduler.
async function seedLaunchpadAlone(deps: Deps, clock: FastClock, log: Logger): Promise<void> {
  const endAt = new Date();
  const startAt = new Date(endAt.getTime() - LAUNCH_WINDOW_DAYS * DAY_MS);
  const tickMs = TICK_HOURS * HOUR_MS;
  const ticks = Math.ceil((endAt.getTime() - startAt.getTime()) / tickMs);
  const coins = launchSeeder(deps, clock, { endAt, seed: deps.config.demo.seed }, log);
  const startedMs = Date.now();
  log.info({ days: LAUNCH_WINDOW_DAYS, ticks, from: startAt.toISOString() }, 'fast-forwarding the launchpad');
  let steps = 0;
  for (let tick = 0; tick <= ticks; tick++) {
    const now = new Date(Math.min(endAt.getTime(), startAt.getTime() + tick * tickMs));
    clock.set(now);
    await coins.upTo(now);
    steps += await stepDueAgents(deps, now, log, coins.agentIds);
    await payCreatorFees(deps, coins, now, log);
  }
  clock.release();
  const restarts = await handOverToRealTime(deps, coins.agentIds);
  log.info(
    { ...(await launchCounts(deps)), steps, restarts, seconds: Math.round((Date.now() - startedMs) / 1000) },
    'demo launchpad ready; the live scheduler has it now',
  );
}

// The colony's whole float, bought once from a synthetic buyer. Without it `fundAgent` has nothing
// to move and every seeded spawn would sit in `spawning`.
async function fundDemoTreasury(deps: Deps, log: Logger): Promise<void> {
  const treasury = treasuryService(deps);
  if (!deps.chain.faucet) throw new Error('sim: the demo needs CHAIN_MODE=memory (the chain has no faucet)');
  const floatMicro = usd(deps.config.demo.treasuryUsd);
  // The memory chain already genesis-credits DEMO_TREASURY_USD at creation, so only ever top up the
  // shortfall: faucetting the full amount again would double the colony's float.
  const held = await deps.chain.getUsdcBalance(treasury.walletPubkey);
  if (held < floatMicro) await deps.chain.faucet(treasury.walletPubkey, floatMicro - held, 'sim-sales');
  await treasury.sync();
  log.info({ treasuryUsd: deps.config.demo.treasuryUsd }, 'treasury floated for the demo colony');
}

// One `pool_txs` purchase row per seeded agent — every one of them, including the fork — at the tier
// it was cast with, so the gross/fee/net arithmetic on the Treasury panel adds up to the agents that
// exist. The agent's share is faucetted into the treasury wallet first: booking an inflow the chain
// never saw would leave the row ahead of the balance, and the next `sync` would report it as drift
// once per sale.
async function bookDemoSale(deps: Deps, key: string, tierId: string | null, fundingMicro: number): Promise<void> {
  if (!tierId || fundingMicro <= 0) return;
  const grossMicro = fundingMicro + bpsOf(fundingMicro, FOUNDER_FEE_BPS_DEFAULT);
  const treasury = treasuryService(deps);
  // The founder's 10% never reaches the treasury (§2.6: it is paid out of the deposit address), so
  // only the funding half arrives — and it leaves again the moment the agent is funded.
  if (deps.chain.faucet) await deps.chain.faucet(treasury.walletPubkey, fundingMicro, 'sim-sales');
  await treasury.recordPurchase({
    purchaseId: `demo-${key}`,
    grossMicro,
    feeMicro: grossMicro - fundingMicro,
    usdcInflowMicro: fundingMicro,
    txSig: null,
    kind: 'purchase',
  }).catch(() => undefined);      // a re-run of the same colony must not fail on the idempotency guard
}

const recordDemoSale = (deps: Deps, member: ColonyMember): Promise<void> =>
  bookDemoSale(deps, member.spawn.agentId ?? member.spawn.name, member.spawn.tierId, member.spawn.fundingMicro);

export interface PendingSale { name: string; amountUsd: number; paidUsd: number; directive: string }

// Two agents somebody has started buying and not finished paying for. Real `purchases` rows on the
// real clock — one untouched, one part-paid — so the buy flow is visible the moment the demo comes up:
// `/buy/:id` shows the deposit address, the countdown and (in memory mode) the SIMULATE PAYMENT button.
// A part-payment under MIN_PURCHASE_USD stays pending, which is what makes the page say
// "received $4.00 of $50.00" rather than just spinning.
export const PENDING_SALES: readonly PendingSale[] = [
  {
    name: 'LANTERN', amountUsd: 25, paidUsd: 0,
    directive: 'Find one small thing strangers will pay for this week, sell it, and spend nothing that has not already made money.',
  },
  {
    name: 'TROVE', amountUsd: 50, paidUsd: 4,
    directive: 'Publish one paid API that does a single useful thing, price it low, and keep it up.',
  },
];

// Their claim codes are generated and hashed exactly like any other purchase's and are never logged
// (SPEC-V2 §11 rule 4). A local tester who wants a code buys their own agent at /buy, where the code is
// shown once in the browser.
async function seedPendingPurchases(deps: Deps, log: Logger): Promise<number> {
  const payments = deps.payments;
  if (!payments) return 0;
  let created = 0;
  for (const sale of PENDING_SALES) {
    try {
      const { purchase } = await payments.createPurchase({
        amountMicro: usd(sale.amountUsd),
        name: sale.name,
        directive: sale.directive,
        path: 'deposit',
      });
      if (sale.paidUsd > 0 && purchase.depositPubkey && deps.chain.faucet) {
        await deps.chain.faucet(purchase.depositPubkey, usd(sale.paidUsd), 'sim-buyer');
      }
      created += 1;
      log.info(
        { purchaseId: purchase.id, agentName: sale.name, quotedUsd: sale.amountUsd, paidUsd: sale.paidUsd },
        'seeded a pending purchase; open /buy/<purchaseId> to watch the buy flow',
      );
    } catch (e) {
      log.warn({ err: errorMessage(e), agentName: sale.name }, 'seeding a pending purchase failed');
    }
  }
  return created;
}

// Owners of agents that wrote a strategy turn sharing on, which is what makes forking visible in the UI.
async function shareStrategies(deps: Deps): Promise<number> {
  const rows = await deps.db.update(agents).set({ shareStrategy: true })
    .where(and(isNotNull(agents.strategy), ne(agents.strategy, ''), eq(agents.shareStrategy, false)))
    .returning({ id: agents.id });
  return rows.length;
}

// One fork of the best-performing shared strategy, so the lineage panels have something real in them.
// Returns whether a child was actually born: there is nothing to fork until somebody has written a
// strategy, and the caller keeps asking until there is.
async function forkBestStrategy(deps: Deps, log: Logger): Promise<boolean> {
  await shareStrategies(deps);
  const [parent] = await deps.db.select().from(agents)
    .where(and(eq(agents.status, 'alive'), eq(agents.shareStrategy, true), isNotNull(agents.strategy)))
    .orderBy(sql`${agents.revenueExternalMicro} desc`).limit(1);
  if (!parent) return false;
  const fundingMicro = parent.fundingMicro > 0 ? parent.fundingMicro : usd(9);
  try {
    // The fork is furniture like every other seeded agent, so somebody bought it too: book the sale
    // before the spawn, or the treasury pays out money no purchase ever put in.
    await bookDemoSale(deps, FORK_CHILD_ID, parent.tier, fundingMicro);
    const child = await deps.services!.spawn({
      agentId: FORK_CHILD_ID, ownerWallet: 'demo-wallet-fork', ownerKind: 'wallet',
      name: `${parent.name.slice(0, 11)}-II`,
      directive: `Run ${parent.name}'s published strategy, but cut anything in it that does not pay for itself.`,
      tools: parent.enabledTools, model: parent.model, effort: parent.effort,
      heartbeatMin: parent.heartbeatMin, forkOf: parent.id,
      fundingMicro,
      tierId: parent.tier, purchaseId: null,
    });
    log.info({ parent: parent.name, child: child.name }, 'forked the leading strategy');
    return true;
  } catch (e) {
    log.warn({ err: errorMessage(e), parent: parent.name }, 'demo fork failed');
    return false;
  }
}

// Every survivor's next heartbeat is a fast-forward timestamp now in the past, so without this they
// would all step at once and then leave the observatory silent for a quarter of an hour. Give each one
// a first step somewhere inside its OWN heartbeat window instead: the colony reaches its steady-state
// cadence (Σ 1/heartbeat ≈ one step a minute) from the first minute and never falls quiet.
async function handOverToRealTime(deps: Deps, only?: readonly string[]): Promise<number> {
  const running = inArray(agents.status, ['alive', 'sleeping']);
  const alive = await deps.db.select({ id: agents.id, status: agents.status, heartbeatMin: agents.heartbeatMin })
    .from(agents).where(only ? and(running, inArray(agents.id, [...only])) : running).orderBy(asc(agents.bornAt));
  const now = Date.now();
  for (const [i, row] of alive.entries()) {
    const window = Math.max(HANDOVER_MIN_DELAY_MS, row.heartbeatMin * MINUTE_MS);
    const at = new Date(now + Math.round(((i + 1) / alive.length) * window));   // birth order → reproducible
    await deps.db.update(agents)
      .set({ nextStepAt: at, ...(row.status === 'sleeping' ? { sleepUntil: at } : {}) })   // sleepers wake on their turn
      .where(eq(agents.id, row.id));
  }
  return alive.length;
}

interface Counts { alive: number; dead: number; externalRevenue: string }

async function statusCounts(deps: Deps): Promise<Counts> {
  const [row] = await deps.db.select({
    alive: sql<number>`count(*) filter (where ${agents.status} <> 'dead')::int`,
    dead: sql<number>`count(*) filter (where ${agents.status} = 'dead')::int`,
    external: sql<number>`coalesce(sum(${agents.revenueExternalMicro}), 0)::bigint`,
  }).from(agents);
  return { alive: row?.alive ?? 0, dead: row?.dead ?? 0, externalRevenue: fmtUsd(Number(row?.external ?? 0)) };
}

interface LaunchCounts { coins: number; dormant: number; burned: number; feesClaimed: string }

async function launchCounts(deps: Deps): Promise<LaunchCounts> {
  const [row] = await deps.db.select({
    coins: sql<number>`count(*)::int`,
    dormant: sql<number>`count(*) filter (where ${agents.status} = 'dormant')::int`,
    burned: sql<number>`count(*) filter (where exists (select 1 from ${burns} where ${burns.launchId} = ${launches.id} and ${burns.burnTxSig} is not null))::int`,
    fees: sql<number>`coalesce(sum(${agents.creatorRewardMicro}), 0)::bigint`.mapWith(Number),
  }).from(launches).innerJoin(agents, eq(agents.id, launches.agentId)).where(eq(launches.state, 'launched'));
  return { coins: row?.coins ?? 0, dormant: row?.dormant ?? 0, burned: row?.burned ?? 0, feesClaimed: fmtUsd(row?.fees ?? 0) };
}

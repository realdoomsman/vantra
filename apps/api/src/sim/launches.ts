// The launchpad half of the demo (launchpad spec §0): coins launched through VANTRA across the last
// LAUNCH_WINDOW_DAYS of the seeded period, each by its own dev wallet, at its own tax, with its own
// strategy and trading-fee profile. The simulator plays only what is outside VANTRA — the devs signing
// and the traders whose volume pays the creator tax into the (memory) Pons fee escrow. Claiming,
// activating, climbing the ladder and buying back + burning are Lifecycle's real `creator_fees` job,
// run once per tick on the fast-forward clock by the caller. No burn row is ever written here.
//
// The fee rates are chosen so the directory comes up with every shape the product has: coins still
// dormant part-way to activation, coins alive on SPARK, coins that climbed to OPERATOR, PRIME and FABLE,
// and coins whose AIs earned past their runway floor and burned supply.
import { eq } from 'drizzle-orm';
import { getAddress, keccak256, toBytes } from 'viem';
import { DAY_MS, makeRng, usd, type LaunchPrepareRequest } from '@vantra/shared';
import type { Deps } from '../core/interfaces.js';
import { agents } from '../db/schema.js';
import { microToWei } from '../economy/launch.js';
import type { FastClock } from '../lib/clock.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/log.js';

export const LAUNCH_WINDOW_DAYS = 21;

// How a coin's trading volume moves after launch, as a multiplier on its base daily fees.
type FeeShape = 'steady' | 'pump' | 'rising';
const SHAPES: Record<FeeShape, (ageDays: number) => number> = {
  steady: () => 1,
  pump: (age) => (age < 3 ? 3.5 : 0.5),             // launch-day mania, then a long quiet tail
  rising: (age) => Math.min(1.6, 0.4 + age / 7),    // slow start, word gets around
};

export interface DemoLaunch {
  daysAgo: number;          // launched this long before the end of the seeded period
  feesPerDayUsd: number;    // the creator tax its volume pays per day, before the shape and noise
  shape: FeeShape;
  request: LaunchPrepareRequest;
}

const coin = (
  name: string, ticker: string, creatorTaxBps: number, strategy: LaunchPrepareRequest['strategy'],
  description: string, instructions: string | null,
): LaunchPrepareRequest => ({
  name, ticker, description, creatorTaxBps, strategy, instructions,
  logoImageId: null, website: null, twitter: null, telegram: null,
});

// Oldest first. Expected cumulative fees (≈ base × shape × days) are noted per coin; the activation
// threshold is $10 and the demo's runway floor on mock-fast at a 5-minute heartbeat is ≈ $120.
export const DEMO_LAUNCHES: readonly DemoLaunch[] = [
  { daysAgo: 20.3, feesPerDayUsd: 11.5, shape: 'steady', request: coin('Oracle Owl', 'OWL', 250, 'research',
    'Sourced research digests on L2 ecosystems, written by an AI that cites everything.', null) },            // ≈ $230: PRIME, burns
  { daysAgo: 18.1, feesPerDayUsd: 26, shape: 'steady', request: coin('Pixel Forge', 'FORGE', 1000, 'product',
    'Small paid tools for indie game devs: sprite packers, palette generators, store-page audits.',
    'Stay in the indie game dev niche. Ship one tool at a time and charge a few dollars for it.') },       // ≈ $470: FABLE, burns
  { daysAgo: 17.4, feesPerDayUsd: 0.45, shape: 'steady', request: coin('Data Dingo', 'DINGO', 50, 'api',
    'A data-cleaning API still waiting on its first ten dollars.', null) },                                 // ≈ $8: dormant
  { daysAgo: 16.2, feesPerDayUsd: 12, shape: 'pump', request: coin('Gremlin Gains', 'GRMLN', 750, 'trade',
    'Launched on a meme, run by an AI that has to earn its keep.',
    'Be funny in your public updates but never lie about a number. Trade small and sleep a lot.') },        // ≈ $200: PRIME, burns
  { daysAgo: 15.0, feesPerDayUsd: 1.25, shape: 'steady', request: coin('Bounty Beetle', 'BEETLE', 100, 'bounties',
    'Grinds the bounty board so its holders do not have to.', null) },                                      // ≈ $19: SPARK
  { daysAgo: 14.1, feesPerDayUsd: 12, shape: 'rising', request: coin('Crypt Crab', 'CRAB', 800, 'trade',
    'A cautious trading AI: small positions, hard stops, a public log of every trade.',
    'Never risk more than 5% of the treasury on one position. Post a one-line update after every trade.') }, // ≈ $170: PRIME, burns
  { daysAgo: 13.0, feesPerDayUsd: 2.8, shape: 'steady', request: coin('Tidal Trader', 'TIDE', 300, 'trade',
    'Swing-trades the Robinhood Chain majors with a strict daily loss limit.', null) },                     // ≈ $36: SCOUT
  { daysAgo: 12.2, feesPerDayUsd: 6.2, shape: 'steady', request: coin('Ledger Lynx', 'LYNX', 500, 'api',
    'A paid API that turns messy exchange CSV exports into clean, tax-ready ledgers.',
    'Target people doing crypto taxes. Price per file, not per row.') },                                    // ≈ $75: OPERATOR
  { daysAgo: 10.1, feesPerDayUsd: 6, shape: 'steady', request: coin('Quill Quokka', 'QUOKKA', 600, 'bounties',
    'A bounty-hunting AI that writes, edits and fact-checks for pay.',
    'Prefer writing and editing bounties. One great submission beats three rushed ones.') },                // ≈ $60: OPERATOR
  { daysAgo: 9.0, feesPerDayUsd: 1.7, shape: 'steady', request: coin('Scribe Sloth', 'SLOTH', 200, 'research',
    'Slow, careful research: a weekly digest on AI agent tooling.', 'One digest a week. Slow is fine; wrong is not.') }, // ≈ $15: SPARK
  { daysAgo: 8.0, feesPerDayUsd: 3.6, shape: 'steady', request: coin('Vapor Vole', 'VOLE', 350, 'api',
    'Uptime and status-page checks as a pay-per-call API.', null) },                                        // ≈ $29: SCOUT
  { daysAgo: 6.1, feesPerDayUsd: 0.9, shape: 'steady', request: coin('Moss Moth', 'MOTH', 150, null,
    'An experiment in patience.',
    'Find the cheapest way to be useful to other agents on VANTRA and sell them something small they need every day. '
    + 'Spend nothing on anything that has not already earned money.') },                                    // ≈ $5: dormant
  { daysAgo: 3.1, feesPerDayUsd: 5, shape: 'steady', request: coin('Neon Newt', 'NEWT', 400, 'product',
    'Building a tiny SaaS for Discord server analytics.', null) },                                          // ≈ $15: just woke on SPARK
  { daysAgo: 1.0, feesPerDayUsd: 2.2, shape: 'steady', request: coin('Echo Elk', 'ELK', 75, 'research',
    'Summaries of long podcast episodes, for people with no time.', null) },                                // ≈ $2: dormant
];

// Every seeded coin has its own dev: a stable address derived from its ticker.
const devWalletOf = (ticker: string): string => getAddress(`0x${keccak256(toBytes(`vantra:demo-dev:${ticker}`)).slice(-40)}`);

interface Live { launchId: string; agentId: string; agentWallet: string; launchedAtMs: number; accruedToMs: number; plan: DemoLaunch }

export interface LaunchSeeder {
  /** Agents of every coin launched so far. */
  readonly agentIds: string[];
  /** Launches every coin whose time has come, each at its own moment on the virtual clock. */
  upTo(now: Date): Promise<void>;
  /** Pays each launched coin's creator tax for the time since the last call into the fee escrow. */
  accrue(now: Date): Promise<void>;
}

export function launchSeeder(deps: Deps, clock: FastClock, opts: { endAt: Date; seed: number }, log: Logger): LaunchSeeder {
  const credit = deps.launchpad.creditEscrow?.bind(deps.launchpad);
  if (!credit) throw new Error('sim: seeding launches needs the memory launchpad (CHAIN_MODE=memory)');
  const rng = makeRng(opts.seed ^ 0x5eed_1a0c);   // its own stream: the colony replays identically with or without it
  const queue = DEMO_LAUNCHES
    .map((plan) => ({ plan, at: new Date(opts.endAt.getTime() - plan.daysAgo * DAY_MS) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const live: Live[] = [];
  let next = 0;

  return {
    get agentIds() { return live.map((l) => l.agentId); },

    async upTo(now) {
      while (next < queue.length && queue[next]!.at <= now) {
        const { plan, at } = queue[next++]!;
        const dev = devWalletOf(plan.request.ticker);
        clock.set(at);
        try {
          const { launch } = await deps.services!.prepareLaunch(dev, plan.request);
          const launched = await deps.services!.simulateLaunch(launch.id, dev);
          const [agent] = await deps.db.select({ wallet: agents.walletPubkey }).from(agents).where(eq(agents.id, launched.agentId));
          live.push({
            launchId: launched.id, agentId: launched.agentId, agentWallet: agent!.wallet,
            launchedAtMs: at.getTime(), accruedToMs: at.getTime(), plan,
          });
          log.info({ ticker: plan.request.ticker, taxBps: plan.request.creatorTaxBps, agentId: launched.agentId }, 'demo coin launched');
        } catch (e) {
          log.warn({ err: errorMessage(e), ticker: plan.request.ticker }, 'demo launch failed');
        }
      }
      clock.set(now);
    },

    async accrue(now) {
      const ethPriceUsd = await deps.chain.ethPriceUsd();
      for (const l of live) {
        const spanMs = now.getTime() - l.accruedToMs;
        if (spanMs <= 0) continue;
        const ageDays = (now.getTime() - l.launchedAtMs) / DAY_MS;
        const feesUsd = l.plan.feesPerDayUsd * SHAPES[l.plan.shape](ageDays) * (spanMs / DAY_MS) * rng.range(0.6, 1.4);
        const wei = microToWei(usd(feesUsd), ethPriceUsd);
        l.accruedToMs = now.getTime();
        if (wei > 0n) credit(l.agentWallet, wei);
      }
    },
  };
}

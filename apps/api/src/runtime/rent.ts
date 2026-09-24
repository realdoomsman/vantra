// Rent and hosting (SPEC §8.5, AMENDMENTS B13). One window `[last_rent_at, until)` is billed at the
// rate of the status held over it, so every status transition charges first and then moves the clock.
import { eq } from 'drizzle-orm';
import {
  DAY_MS, HOSTING_PER_DAY_MICRO, HOUR_MS, RENT_SLEEP_PER_HOUR_MICRO, fmtUsd, type AgentStatus, type Micro,
} from '@vantra/shared';
import type { CoreDeps } from '../core/interfaces.js';
import { agents, type AgentRow } from '../db/schema.js';
import { activeDeploymentCount } from '../economy/agents.js';
import { post } from '../economy/ledger.js';
import { withTx } from '../economy/tx.js';

export interface RentRates { alivePerHour: Micro; sleepPerHour: Micro; hostingPerDay: Micro }
export interface RentCharge { agent: AgentRow; rentMicro: Micro; hostingMicro: Micro; sites: number }

type Deps = Pick<CoreDeps, 'db' | 'clock' | 'bus' | 'config' | 'log'>;

export const ratesOf = (deps: Pick<CoreDeps, 'config'>): RentRates => ({
  alivePerHour: deps.config.economy.rentPerHourMicro,
  sleepPerHour: RENT_SLEEP_PER_HOUR_MICRO,
  hostingPerDay: HOSTING_PER_DAY_MICRO,
});

// Paused agents are stopped like sleepers and pay the sleep rate (B13). Dead agents pay nothing, and
// neither does a dormant launchpad agent: it is not running, and billing it would push a coin's AI into
// debt while it waits for the fees that wake it.
export function rentRateOf(status: AgentStatus, rates: RentRates): Micro {
  switch (status) {
    case 'alive': return rates.alivePerHour;
    case 'sleeping': case 'paused': return rates.sleepPerHour;
    case 'dormant': case 'spawning': case 'dead': return 0;
  }
}

const prorate = (perPeriod: Micro, ms: number, periodMs: number): Micro => Math.round((perPeriod * ms) / periodMs);

export const rentForMs = (status: AgentStatus, ms: number, rates: RentRates): Micro => prorate(rentRateOf(status, rates), ms, HOUR_MS);
export const hostingForMs = (sites: number, ms: number, rates: RentRates): Micro => prorate(sites * rates.hostingPerDay, ms, DAY_MS);

// Bills [last_rent_at, until). Returns the agent with a fresh treasury; the window only moves when the
// charge was actually posted, so sub-micro intervals accrue instead of rounding away.
export async function chargeRent(deps: Deps, agent: AgentRow, until: Date): Promise<RentCharge> {
  const ms = until.getTime() - agent.lastRentAt.getTime();
  const rates = ratesOf(deps);
  const rate = rentRateOf(agent.status, rates);
  if (ms <= 0) return { agent, rentMicro: 0, hostingMicro: 0, sites: 0 };
  if (rate === 0) {
    const [row] = await deps.db.update(agents).set({ lastRentAt: until }).where(eq(agents.id, agent.id)).returning();
    return { agent: row ?? agent, rentMicro: 0, hostingMicro: 0, sites: 0 };
  }
  const rentMicro = rentForMs(agent.status, ms, rates);
  if (rentMicro <= 0) return { agent, rentMicro: 0, hostingMicro: 0, sites: 0 };
  const sites = await activeDeploymentCount(deps.db, agent.id);
  const hostingMicro = hostingForMs(sites, ms, rates);
  const hours = ms / HOUR_MS;

  return withTx(deps.db, async (tx) => {
    let current = (await post(deps, tx, {
      agentId: agent.id, kind: 'rent', amountMicro: -rentMicro, ts: until,
      memo: `rent ${hours.toFixed(2)}h @ ${fmtUsd(rate)}/h (${agent.status})`,
      meta: { hours, ratePerHourMicro: rate, status: agent.status },
    })).agent;
    if (hostingMicro > 0) {
      current = (await post(deps, tx, {
        agentId: agent.id, kind: 'hosting', amountMicro: -hostingMicro, ts: until,
        memo: `hosting ${sites} site${sites === 1 ? '' : 's'} ${hours.toFixed(2)}h`,
        meta: { sites, hours },
      })).agent;
    }
    const [row] = await tx.update(agents).set({ lastRentAt: until }).where(eq(agents.id, agent.id)).returning();
    return { agent: row ?? { ...current, lastRentAt: until }, rentMicro, hostingMicro, sites };
  });
}

// One heartbeat of fixed cost, used by minStep and the spawn-page projection (B14). An agent that is not
// running (dead, or dormant until its fees wake it) is projected at the rate it would pay awake.
export function fixedCostPerHeartbeat(agent: Pick<AgentRow, 'status' | 'heartbeatMin'>, sites: number, rates: RentRates): Micro {
  const ms = agent.heartbeatMin * 60_000;
  const status = agent.status === 'dead' || agent.status === 'dormant' ? 'alive' : agent.status;
  return rentForMs(status, ms, rates) + hostingForMs(sites, ms, rates);
}

// Burn & runway math. AMENDMENTS B15: projected burn for young agents, trailing burn after day one.
import { DAY_MS, HOUR_MS, estimateMicro, type AgentStatus, type BurnBasis, type Micro, type ModelPricing } from '@vantra/shared';

export interface BurnRates { rentAlivePerHour: Micro; rentSleepPerHour: Micro; hostingPerDay: Micro }
export interface BurnInputs {
  status: AgentStatus;
  heartbeatMin: number;
  sleepMinutes: number | null;      // while sleeping: length of the current sleep
  activeDeployments: number;
  stepCosts: Micro[];               // last ≤20 finished steps, newest first
  model: ModelPricing | null;       // pricing used when no steps exist yet
  trailingSpend: Micro;             // protocol spend over the trailing window
  ageDays: number;                  // float
  treasuryMicro: Micro;
}
export interface Burn { burnPerDayMicro: Micro; burnBasis: BurnBasis; projectedMicro: Micro; trailingMicro: Micro; runwayDays: number | null }

const MIN_AGE_DAYS = 1 / 24;

export function rentPerHour(status: AgentStatus, rates: BurnRates): Micro {
  if (status === 'alive') return rates.rentAlivePerHour;
  if (status === 'sleeping' || status === 'paused') return rates.rentSleepPerHour;
  return 0;
}

export function projectedBurn(i: BurnInputs, rates: BurnRates): Micro {
  const rentPerDay = rentPerHour(i.status, rates) * (DAY_MS / HOUR_MS);
  const hostingPerDay = i.activeDeployments * rates.hostingPerDay;
  const stepsPerDay = i.status === 'alive' ? 1440 / i.heartbeatMin
    : i.status === 'sleeping' ? 1440 / (i.sleepMinutes ?? i.heartbeatMin)
    : 0;
  const avgStepCost = i.stepCosts.length > 0
    ? i.stepCosts.reduce((a, b) => a + b, 0) / i.stepCosts.length
    : i.model ? estimateMicro(i.model, 6000, 1500) : 0;
  return Math.round(rentPerDay + hostingPerDay + stepsPerDay * avgStepCost);
}

export function trailingBurn(i: BurnInputs): Micro {
  const days = Math.max(MIN_AGE_DAYS, Math.min(i.ageDays, 7));
  return Math.round(i.trailingSpend / days);
}

export function computeBurn(i: BurnInputs, rates: BurnRates): Burn {
  const projectedMicro = projectedBurn(i, rates);
  const trailingMicro = trailingBurn(i);
  const burnBasis: BurnBasis = i.ageDays < 1 ? 'projected' : 'trailing';
  const burnPerDayMicro = burnBasis === 'projected' ? projectedMicro : trailingMicro;
  const runwayDays = burnPerDayMicro > 0 ? round1(Math.max(0, i.treasuryMicro) / burnPerDayMicro) : null;
  return { burnPerDayMicro, burnBasis, projectedMicro, trailingMicro, runwayDays };
}

export const ageDaysOf = (bornAt: Date, endAt: Date): number => Math.max(0, endAt.getTime() - bornAt.getTime()) / DAY_MS;
export const round1 = (n: number): number => Math.round(n * 10) / 10;

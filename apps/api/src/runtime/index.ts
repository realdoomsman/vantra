import type { Deps, Runtime } from '../core/interfaces.js';
import { createScheduler } from './scheduler.js';

// Scheduler + step loop + rent, deposits, death, settlement. SPEC §8.5–§8.13; AMENDMENTS §B.
export function createRuntime(deps: Deps): Runtime {
  const scheduler = createScheduler(deps);
  return {
    start: () => scheduler.start(),
    stop: () => scheduler.stop(),
    runStep: (agentId) => scheduler.runStepNow(agentId),
  };
}

export { createScheduler, type JobName, type Scheduler } from './scheduler.js';
export { runStep, type StepOutcome } from './step.js';
export { chargeRent, fixedCostPerHeartbeat, ratesOf, rentForMs, hostingForMs, type RentRates } from './rent.js';
export { scanDeposits, type Deposit } from './deposits.js';
export { die, goBroke, type BrokeCause } from './death.js';
export { buildPostmortem } from './postmortem.js';
export { runSettlement, settleAgent } from './settlement.js';
export { preflight, budgetFor, stepCapOf, usageCost, tokensOf, type Preflight } from './metering.js';
export { systemPrompt, promptInputsFor, type PromptInputs } from './prompts.js';
export { buildContext, fit } from './context.js';
export { wakeAgent, wakeForBounty, wakeSoon, wakeBountyFanout, type WakeReason } from './wake.js';

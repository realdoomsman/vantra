// The outside world in demo mode (SPEC §8.18): customers who pay agents that actually shipped
// something, and owners who occasionally rescue a failing agent. Both arrive as real USDC on the
// memory chain, so the agent discovers them through the ordinary deposit scan and classifies them
// itself — nothing here writes to the ledger.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { MICRO, usd, type Micro, type Rng } from '@vantra/shared';
import { DEMO_CUSTOMER_WALLETS } from '../config.js';
import type { CoreDeps } from '../core/interfaces.js';
import { agents, deployments, projects, services, type AgentRow } from '../db/schema.js';
import { personaFor } from '../llm/providers/mock/persona.js';

// Single-sourced in config.ts, which allow-lists them as external payers when DEMO=1 (deposits.ts
// otherwise books an unknown sender as `pending`, so the demo colony would never show revenue).
const CUSTOMERS: readonly string[] = DEMO_CUSTOMER_WALLETS;

// Demand is quadratic in competence, so the long tail of mediocre agents never earns its rent and
// dies — which is the whole point of the observatory. While the colony fast-forwards it burns only
// ~$0.15–0.30 per agent-day (two steps a day on the mock models plus rent), so deaths arrive in the
// live phase, where the 5-minute demo heartbeat burns a SPARK floor in about two days.
const PAY_BASE_CHANCE = 0.30;          // × competence² × shipped things, per tick
const MAX_PAY_CHANCE = 0.35;
const RESCUE_CHANCE = 0.18;            // an owner noticing a nearly-dead agent
const RESCUE_FLOOR_MICRO = 1_500_000;  // $1.50 — below this the owner may step in
const RESCUE_USD = [4, 5, 8, 10] as const;

export interface DemandResult { paid: number; paidMicro: Micro; rescued: number }

// Faucets USDC into a wallet from a named outside sender. Memory chain only.
export async function faucetTo(deps: CoreDeps, to: string, amountMicro: Micro, from: string): Promise<string> {
  if (!deps.chain.faucet) throw new Error('sim: the demo needs CHAIN_MODE=memory (the chain has no faucet)');
  const { sig } = await deps.chain.faucet(to, amountMicro, from);
  return sig;
}

// One pass of outside demand. Agents are paid in proportion to competence × what they have shipped,
// which is what makes the colony's survivors look earned rather than assigned.
export async function runDemand(deps: CoreDeps, rng: Rng): Promise<DemandResult> {
  const rows = await liveAgents(deps);
  const result: DemandResult = { paid: 0, paidMicro: 0, rescued: 0 };

  for (const { agent, shipped } of rows) {
    const competence = personaFor(agent.id).competence;
    if (shipped > 0) {
      const chance = Math.min(MAX_PAY_CHANCE, PAY_BASE_CHANCE * competence * competence * Math.min(3, shipped));
      if (rng.chance(chance)) {
        const amount = payment(rng, competence);
        await faucetTo(deps, agent.walletPubkey, amount, rng.pick(CUSTOMERS));
        result.paid += 1;
        result.paidMicro += amount;
      }
    }
    if (agent.treasuryMicro < RESCUE_FLOOR_MICRO && agent.recapitalizedMicro === 0 && rng.chance(RESCUE_CHANCE * competence)) {
      await faucetTo(deps, agent.walletPubkey, usd(rng.pick(RESCUE_USD)), agent.ownerWallet);
      result.rescued += 1;
    }
  }
  return result;
}

// $0.15–$2.10, skewed low: most sales are small, the good agents land the bigger ones.
function payment(rng: Rng, competence: number): Micro {
  const base = rng.range(0.15, 0.85) * (1 + competence * 1.5);
  return Math.max(10_000, Math.round(base * MICRO));
}

interface LiveAgent { agent: AgentRow; shipped: number }

// "Shipped" = live projects + active services + active deployments, i.e. things a customer could buy.
async function liveAgents(deps: CoreDeps): Promise<LiveAgent[]> {
  const rows = await deps.db.select().from(agents)
    .where(inArray(agents.status, ['alive', 'sleeping'])).limit(500);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [liveProjects, activeServices, activeSites] = await Promise.all([
    deps.db.select({ agentId: projects.agentId, n: sql<number>`count(*)::int` }).from(projects)
      .where(and(inArray(projects.agentId, ids), eq(projects.status, 'live'))).groupBy(projects.agentId),
    deps.db.select({ agentId: services.agentId, n: sql<number>`count(*)::int` }).from(services)
      .where(and(inArray(services.agentId, ids), eq(services.status, 'active'))).groupBy(services.agentId),
    deps.db.select({ agentId: deployments.agentId, n: sql<number>`count(*)::int` }).from(deployments)
      .where(and(inArray(deployments.agentId, ids), eq(deployments.active, true))).groupBy(deployments.agentId),
  ]);

  const counts = new Map<string, number>();
  for (const group of [liveProjects, activeServices, activeSites]) {
    for (const row of group) counts.set(row.agentId, (counts.get(row.agentId) ?? 0) + row.n);
  }
  return rows.map((agent) => ({ agent, shipped: counts.get(agent.id) ?? 0 }));
}

// AgentRow → AgentPublic / AgentDetail with batch-loaded derived fields (burn, phase, fork counts).
import { and, asc, desc, eq, gt, inArray, lt, lte, or, sql } from 'drizzle-orm';
import {
  DAY_MS, HOSTING_PER_DAY_MICRO, RENT_SLEEP_PER_HOUR_MICRO,
  type AgentDetail, type AgentPhase, type AgentPublic, type AgentRef, type Micro, type ModelPricing, type OwnerMessage,
  type TierId,
} from '@vantra/shared';
import type { CoreDeps } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import {
  agents, bounties, decisions, deployments, forks, ledger, ownerMessages, projects, services, steps, trades, type AgentRow,
} from '../db/schema.js';
import { ageDaysOf, computeBurn, round1, type Burn, type BurnRates } from './burn.js';
import { listDecisions } from './events.js';
import { launchedLaunchOf } from './ladder.js';
import { PROTOCOL_SPEND_KIND_LIST, listLedger, profitOf, treasurySeries } from './ledger.js';
import { liveSteps } from './live.js';
import { toBounty, toDeployment, toProject, toService } from './mappers.js';
import { afterCommit } from './tx.js';
import { withdrawableOf } from './withdraw.js';
import { openPositions } from './trading.js';
import { tokenInfoOf, treasurySplit } from './token.js';

type Deps = Pick<CoreDeps, 'db' | 'clock' | 'config' | 'llm' | 'bus' | 'chain'>;

export interface PhaseInputs { lastPivotAt: Date | null; operating: boolean; building: boolean }
interface Extras extends PhaseInputs { forkCount: number; activeDeployments: number; stepCosts: Micro[]; trailingSpend: Micro }

function burnRates(deps: Pick<CoreDeps, 'config'>): BurnRates {
  return { rentAlivePerHour: deps.config.economy.rentPerHourMicro, rentSleepPerHour: RENT_SLEEP_PER_HOUR_MICRO, hostingPerDay: HOSTING_PER_DAY_MICRO };
}

// AMENDMENTS C20 phase rules, in priority order.
export function computePhase(a: Pick<AgentRow, 'status'>, p: PhaseInputs, now: Date): AgentPhase {
  if (a.status === 'dead') return 'dead';
  if (a.status === 'paused') return 'paused';
  if (a.status === 'sleeping') return 'sleeping';
  if (a.status === 'spawning') return 'spawning';
  if (a.status === 'dormant') return 'dormant';
  if (p.lastPivotAt && now.getTime() - p.lastPivotAt.getTime() < DAY_MS) return 'pivoting';
  if (p.operating) return 'operating';
  if (p.building) return 'building';
  return 'exploring';
}

async function phaseInputs(db: DbLike, agentIds: string[]): Promise<Map<string, PhaseInputs>> {
  const out = new Map<string, PhaseInputs>();
  if (agentIds.length === 0) return out;
  const pivots = await db.select({ agentId: decisions.agentId, last: sql<Date | null>`max(${decisions.ts})` })
    .from(decisions).where(and(inArray(decisions.agentId, agentIds), eq(decisions.kind, 'pivot'))).groupBy(decisions.agentId);
  const flags = await db.select({
    agentId: projects.agentId,
    operating: sql<boolean>`bool_or(${projects.status} = 'live' and ${projects.revenueMicro} > 0)`,
    building: sql<boolean>`bool_or(${projects.status} = 'building')`,
  }).from(projects).where(inArray(projects.agentId, agentIds)).groupBy(projects.agentId);
  for (const id of agentIds) out.set(id, { lastPivotAt: null, operating: false, building: false });
  for (const p of pivots) out.get(p.agentId)!.lastPivotAt = p.last ? new Date(p.last) : null;
  for (const f of flags) Object.assign(out.get(f.agentId)!, { operating: f.operating, building: f.building });
  return out;
}

async function loadExtras(deps: Deps, rows: AgentRow[], now: Date): Promise<Map<string, Extras>> {
  const ids = rows.map((r) => r.id);
  const out = new Map<string, Extras>();
  if (ids.length === 0) return out;
  const db = deps.db;
  const [phases, forkCounts, deployCounts, stepCosts, trailing] = await Promise.all([
    phaseInputs(db, ids),
    db.select({ id: forks.parentAgentId, n: sql<number>`count(*)::int` }).from(forks).where(inArray(forks.parentAgentId, ids)).groupBy(forks.parentAgentId),
    db.select({ id: deployments.agentId, n: sql<number>`count(*)::int` }).from(deployments).where(and(inArray(deployments.agentId, ids), eq(deployments.active, true))).groupBy(deployments.agentId),
    recentStepCosts(db, ids),
    trailingSpend(db, ids, now),
  ]);
  for (const r of rows) {
    out.set(r.id, { ...phases.get(r.id)!, forkCount: 0, activeDeployments: 0, stepCosts: stepCosts.get(r.id) ?? [], trailingSpend: trailing.get(r.id) ?? 0 });
  }
  for (const f of forkCounts) out.get(f.id)!.forkCount = f.n;
  for (const d of deployCounts) out.get(d.id)!.activeDeployments = d.n;
  return out;
}

// Last ≤20 finished step costs per agent, newest first (B15 avgStepCost).
async function recentStepCosts(db: DbLike, ids: string[]): Promise<Map<string, Micro[]>> {
  const ranked = db.select({
    agentId: steps.agentId, cost: steps.costMicro,
    rn: sql<number>`row_number() over (partition by ${steps.agentId} order by ${steps.id} desc)`.as('rn'),
  }).from(steps).where(and(inArray(steps.agentId, ids), sql`${steps.status} <> 'running'`)).as('ranked');
  const rows = await db.select({ agentId: ranked.agentId, cost: ranked.cost, rn: ranked.rn }).from(ranked).where(lte(ranked.rn, 20)).orderBy(asc(ranked.rn));
  const out = new Map<string, Micro[]>();
  for (const r of rows) {
    const list = out.get(r.agentId) ?? [];
    list.push(r.cost);
    out.set(r.agentId, list);
  }
  return out;
}

// Protocol spend over the 7 days before now (or before death), per agent.
async function trailingSpend(db: DbLike, ids: string[], now: Date): Promise<Map<string, Micro>> {
  const end = sql`coalesce(${agents.diedAt}, ${now})`;
  const rows = await db.select({ agentId: ledger.agentId, spent: sql<number>`coalesce(sum(-${ledger.amountMicro}), 0)::bigint`.mapWith(Number) })
    .from(ledger).innerJoin(agents, eq(agents.id, ledger.agentId))
    .where(and(inArray(ledger.agentId, ids), inArray(ledger.kind, PROTOCOL_SPEND_KIND_LIST), lt(ledger.amountMicro, 0),
      sql`${ledger.ts} >= ${end} - interval '7 days'`, sql`${ledger.ts} <= ${end}`))
    .groupBy(ledger.agentId);
  return new Map(rows.map((r) => [r.agentId, r.spent]));
}

function pricingFor(deps: Deps, modelId: string): ModelPricing | null {
  const found = deps.llm.models().find((m) => m.id === modelId);
  if (found) return found;
  try { return deps.llm.cheapest(); } catch { return null; }
}

function burnOf(deps: Deps, a: AgentRow, x: Pick<Extras, 'activeDeployments' | 'stepCosts' | 'trailingSpend'>, now: Date): Burn {
  const end = a.diedAt ?? now;
  const sleepMinutes = a.status === 'sleeping' && a.sleepUntil && a.lastStepAt
    ? Math.max(1, Math.round((a.sleepUntil.getTime() - a.lastStepAt.getTime()) / 60_000)) : null;
  return computeBurn({
    status: a.status, heartbeatMin: a.heartbeatMin, sleepMinutes, activeDeployments: x.activeDeployments, stepCosts: x.stepCosts,
    model: pricingFor(deps, a.model), trailingSpend: x.trailingSpend, ageDays: ageDaysOf(a.bornAt, end), treasuryMicro: a.treasuryMicro,
  }, burnRates(deps));
}

// Survival Score (0..100): a live read on how close an agent is to financial extinction. Runway is the
// dominant term; profitability, age and real external revenue lift it; sustained losses erode it.
function survivalScoreOf(a: AgentRow, runwayDays: number | null, profitMicro: Micro, ageDays: number): number {
  const funding = Math.max(a.fundingMicro, 1);
  const runway = Math.min(Math.max(runwayDays ?? Infinity, 0) / 30, 1) * 40;
  const profit = profitMicro >= 0 ? 25 : Math.max(0, 25 * (1 + profitMicro / funding));
  const age = Math.min(ageDays / 30, 1) * 15;
  const revenue = Math.min(a.revenueExternalMicro / funding, 1) * 20;
  return Math.round(Math.max(0, Math.min(100, runway + profit + age + revenue)));
}
function gradeOf(s: number) {
  return s >= 80 ? 'thriving' : s >= 60 ? 'healthy' : s >= 40 ? 'stable' : s >= 20 ? 'at_risk' : 'critical';
}

function isSimulated(deps: Deps, modelId: string): boolean {
  return deps.llm.mode === 'mock' || modelId.startsWith('mock-');
}

function toPublic(deps: Deps, a: AgentRow, x: Extras, now: Date): AgentPublic {
  const burn = burnOf(deps, a, x, now);
  const survivalScore = survivalScoreOf(a, burn.runwayDays, profitOf(a), ageDaysOf(a.bornAt, a.diedAt ?? now));
  const live = liveSteps.get(a.id);
  return {
    id: a.id, name: a.name,
    // A claim owner's id IS the purchase id, so it must never reach a public payload (SPEC-V2 §6.2).
    ownerWallet: a.ownerKind === 'claim' ? null : a.ownerWallet,
    ownerKind: a.ownerKind,
    tierId: (a.tier as TierId | null) ?? null,
    status: a.status, phase: computePhase(a, x, now),
    bornAt: a.bornAt.toISOString(), diedAt: a.diedAt?.toISOString() ?? null, deathCause: a.deathCause,
    directive: a.directive, enabledTools: a.enabledTools, model: a.model, effort: a.effort, heartbeatMin: a.heartbeatMin,
    walletPubkey: a.walletPubkey, deploySlug: a.deploySlug,
    treasuryMicro: a.treasuryMicro, fundingMicro: a.fundingMicro,
    revenueExternalMicro: a.revenueExternalMicro, revenueInternalMicro: a.revenueInternalMicro,
    revenuePendingMicro: a.revenuePendingMicro,
    spendInferenceMicro: a.spendInferenceMicro, spendComputeMicro: a.spendComputeMicro, spendToolsMicro: a.spendToolsMicro,
    spendHostingMicro: a.spendHostingMicro, spendRentMicro: a.spendRentMicro, spendGasMicro: a.spendGasMicro, spendPaymentsMicro: a.spendPaymentsMicro,
    royaltyInMicro: a.royaltyInMicro, royaltyOutMicro: a.royaltyOutMicro,
    recapitalizedMicro: a.recapitalizedMicro, withdrawnMicro: a.withdrawnMicro,
    unsettledMicro: a.unsettledMicro, onchainUsdcMicro: a.onchainUsdcMicro,
    profitMicro: profitOf(a),
    totalSteps: a.totalSteps, lastStepAt: a.lastStepAt?.toISOString() ?? null, nextStepAt: a.nextStepAt?.toISOString() ?? null,
    stepping: live !== null, currentStepStartedAt: live?.startedAt.toISOString() ?? null, currentRound: live?.round ?? null,
    burnPerDayMicro: burn.burnPerDayMicro, burnBasis: burn.burnBasis, runwayDays: burn.runwayDays,
    ageDays: round1(ageDaysOf(a.bornAt, a.diedAt ?? now)),
    summary: a.summary, forkedFrom: a.forkedFrom, forkCount: x.forkCount, generation: a.generation,
    shareStrategy: a.shareStrategy, hasStrategy: !!a.strategy && a.strategy.trim().length > 0,
    revivals: a.revivals, simulated: isSimulated(deps, a.model), spawnError: a.spawnError,
    paidBack: a.fundingMicro > 0 && a.revenueExternalMicro >= a.fundingMicro,
    tradeRealizedMicro: a.tradeRealizedMicro, tradeVolumeMicro: a.tradeVolumeMicro, creatorRewardMicro: a.creatorRewardMicro,
    survivalScore, survivalGrade: gradeOf(survivalScore),
    tokenMint: a.tokenMint, tokenTicker: a.tokenTicker, tokenName: a.tokenName,
    tokenLaunchedAt: a.tokenLaunchedAt?.toISOString() ?? null,
  };
}

export async function toPublicMany(deps: Deps, rows: AgentRow[]): Promise<AgentPublic[]> {
  const now = deps.clock.now();
  const extras = await loadExtras(deps, rows, now);
  return rows.map((r) => toPublic(deps, r, extras.get(r.id)!, now));
}

export async function toPublicOne(deps: Deps, row: AgentRow): Promise<AgentPublic> {
  return (await toPublicMany(deps, [row]))[0]!;
}

// Broadcasts the current public shape of an agent (after commit when called inside a transaction).
export async function emitAgent(deps: Deps, db: DbLike, row: AgentRow, extra: Partial<AgentPublic> = {}): Promise<AgentPublic> {
  const pub = await toPublicOne(deps, row);
  afterCommit(db, () => deps.bus.emit({ type: 'agent', agentId: row.id, patch: { ...pub, ...extra } }));
  return pub;
}

export async function agentNames(db: DbLike, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const rows = await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// `viewerOwnerId` is an OWNER ID (a base58 pubkey or `claim_pu_…`), compared against the ROW, never
// against AgentPublic.ownerWallet — which is null for a claim owner (SPEC-V2 §6.2).
export async function loadDetail(deps: Deps, a: AgentRow, viewerOwnerId: string | null | undefined): Promise<AgentDetail> {
  const db = deps.db;
  const isOwner = !!viewerOwnerId && viewerOwnerId === a.ownerWallet;
  const now = deps.clock.now();
  const [pub, projectRows, decisionList, ledgerRecent, series, serviceRows, posted, claimed, parentRow, childRows, deploymentRows, messages] = await Promise.all([
    toPublicOne(deps, a),
    db.select().from(projects).where(eq(projects.agentId, a.id)).orderBy(desc(projects.updatedAt)),
    listDecisions(db, a.id, 50),
    listLedger(db, a.id, { limit: 30 }),
    treasurySeries(db, a.id),
    db.select().from(services).where(eq(services.agentId, a.id)).orderBy(desc(services.createdAt)),
    db.select().from(bounties).where(and(eq(bounties.posterType, 'agent'), eq(bounties.posterId, a.id))).orderBy(desc(bounties.createdAt)).limit(50),
    db.select().from(bounties).where(eq(bounties.claimerAgentId, a.id)).orderBy(desc(bounties.createdAt)).limit(50),
    a.forkedFrom ? db.select({ id: agents.id, name: agents.name, status: agents.status }).from(agents).where(eq(agents.id, a.forkedFrom)) : Promise.resolve([]),
    db.select({ id: agents.id, name: agents.name, status: agents.status, royaltiesPaidMicro: forks.royaltiesPaidMicro })
      .from(forks).innerJoin(agents, eq(agents.id, forks.childAgentId)).where(eq(forks.parentAgentId, a.id)).orderBy(asc(forks.id)),
    db.select().from(deployments).where(eq(deployments.agentId, a.id)).orderBy(desc(deployments.id)).limit(20),
    isOwner ? db.select().from(ownerMessages).where(eq(ownerMessages.agentId, a.id)).orderBy(desc(ownerMessages.id)).limit(50) : Promise.resolve([]),
  ]);
  const names = await agentNames(db, [...posted, ...claimed].flatMap((b) => [b.posterId, b.claimerAgentId ?? '']));
  names.set(a.id, a.name);
  const lookup = (id: string) => names.get(id) ?? null;
  const parent: AgentRef | null = parentRow[0] ?? null;
  const positions = await openPositions(deps, a.id);
  const tradeRows = await db.select().from(trades).where(eq(trades.agentId, a.id)).orderBy(desc(trades.id)).limit(20);
  const launch = await launchedLaunchOf(db, a.id);
  return {
    ...pub,
    isOwner,
    memory: a.memory,
    strategy: a.shareStrategy || isOwner ? a.strategy : null,
    postmortem: a.postmortem,
    ownerMessages: messages.map(toOwnerMessage).reverse(),
    projects: projectRows.map(toProject),
    decisions: decisionList,
    ledgerRecent,
    series,
    withdrawable: withdrawableOf(a, pub.burnPerDayMicro, now, launch?.ticker ?? null),
    services: serviceRows.map((s) => toService(deps.config, s, a.name, a.walletPubkey)),
    bounties: { posted: posted.map((b) => toBounty(b, lookup)), claimed: claimed.map((b) => toBounty(b, lookup)) },
    parent,
    children: childRows,
    deployments: deploymentRows.map((d) => toDeployment(deps.config, d)),
    positions,
    trades: tradeRows.map((t) => ({ id: t.id, ts: t.ts.toISOString(), action: t.action, symbol: t.symbol, usdcMicro: t.usdcMicro, realizedPnlMicro: t.realizedPnlMicro, txSig: t.txSig })),
    token: tokenInfoOf(a),
    treasurySplit: treasurySplit(a.treasuryMicro, deps.config.trading.minReserveMicro, positions.reduce((sum, p) => sum + p.valueMicro, 0)),
  };
}

export function toOwnerMessage(r: { id: number; ts: Date; fromRole: 'agent' | 'owner'; text: string }): OwnerMessage {
  return { id: r.id, ts: r.ts.toISOString(), from: r.fromRole, text: r.text };
}

// Agents currently due for a heartbeat (used by the scheduler's acquire).
export function dueCondition(now: Date) {
  return and(
    or(eq(agents.status, 'alive'), eq(agents.status, 'sleeping')),
    lte(agents.nextStepAt, now),
    eq(agents.pausedByOwner, false),
    sql`${agents.currentStepId} is null`,
  );
}

export const activeDeploymentCount = async (db: DbLike, agentId: string): Promise<number> => {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(deployments).where(and(eq(deployments.agentId, agentId), eq(deployments.active, true)));
  return row?.n ?? 0;
};


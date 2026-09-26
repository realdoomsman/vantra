// Read side of the economy: global stats, the daily series, agent lists, leaderboards, the graveyard
// and `Me`. SPEC §4, §8.15; AMENDMENTS C20 (phase), C22 (strategies, series), C23 (Me);
// SPEC-V2 §7.7 (the token is gone, the pool is the treasury, `Me` lists every agent you bought).
import { and, asc, desc, eq, inArray, isNotNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  DAY_MS, FORK_ROYALTY_BPS, HOSTING_PER_DAY_MICRO, MAX_STEP_COST_MICRO, MAX_TOOL_ROUNDS_PER_STEP,
  PURCHASE_TTL_HOURS, RENT_SLEEP_PER_HOUR_MICRO, RESERVE_DAYS, RESERVE_MIN_MICRO, REVIVE_WINDOW_DAYS, RHC_EXPLORER_URL,
  STEP_COST_TREASURY_BPS, TOOL_COST_MICRO, WITHDRAW_FEE_BPS, WITHDRAW_MIN_AGE_DAYS, ownerKindOf, walletOfOwnerId,
  type AgentPublic, type ChainPublic, type GlobalStats, type GraveyardEntry, type GraveyardSort, type LeaderboardBy,
  type ListAgentsQuery, type Me, type Micro, type ProjectKind, type ProtocolRules, type SeriesPoint, type StrategyStat,
  type TreasuryPublic,
} from '@vantra/shared';
import { PONS_CREATOR_TAX_BPS_MAX } from '../config.js';
import type { CoreDeps, Payments } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import { agents, ledger, poolSnapshots, poolTxs, projects, type AgentRow } from '../db/schema.js';
import { ageDaysOf, round1 } from './burn.js';
import { PROTOCOL_SPEND_KIND_LIST } from './ledger.js';
import { agentsOfOwner, loadUser } from './repo.js';
import { treasuryService } from './treasury.js';
import { toPublicMany } from './agents.js';
import { wallets } from './wallets.js';

export const MAX_LIST_ROWS = 500;
const STRATEGY_PROJECT_LIMIT = 5_000;

type Deps = CoreDeps & { payments?: Payments };

const LIVE_STATUSES = ['alive', 'sleeping', 'paused'] as const;

export function protocolRules(deps: Pick<CoreDeps, 'config'>): ProtocolRules {
  return {
    minPurchaseMicro: deps.config.economy.minPurchaseMicro,
    maxPurchaseMicro: deps.config.economy.maxPurchaseMicro,
    founderFeeBps: deps.config.economy.founderFeeBps,
    rentPerHourMicro: deps.config.economy.rentPerHourMicro,
    rentSleepPerHourMicro: RENT_SLEEP_PER_HOUR_MICRO,
    hostingPerDayMicro: HOSTING_PER_DAY_MICRO,
    toolCostMicro: TOOL_COST_MICRO,
    maxStepCostMicro: MAX_STEP_COST_MICRO,
    stepCostTreasuryBps: STEP_COST_TREASURY_BPS,
    maxToolRoundsPerStep: MAX_TOOL_ROUNDS_PER_STEP,
    withdrawFeeBps: WITHDRAW_FEE_BPS,
    withdrawMinAgeDays: WITHDRAW_MIN_AGE_DAYS,
    reserveDays: RESERVE_DAYS,
    reserveMinMicro: RESERVE_MIN_MICRO,
    forkRoyaltyBps: FORK_ROYALTY_BPS,
    reviveWindowDays: REVIVE_WINDOW_DAYS,
    purchaseTtlHours: deps.config.economy.purchaseTtlHours || PURCHASE_TTL_HOURS,
    launch: {
      creatorTaxMaxBps: PONS_CREATOR_TAX_BPS_MAX,
      activationMicro: deps.config.launch.activationMicro,
      burnFloorDays: deps.config.launch.burnFloorDays,
      minBurnMicro: deps.config.launch.minBurnMicro,
      modelSwitchMinRunwayDays: deps.config.launch.modelSwitchMinRunwayDays,
    },
  };
}

// The two protocol receive addresses are public: the Market page cannot build the escrow transfer
// POST /api/market/bounties demands without knowing where to send it (SPEC §8.15, §9). Only
// addresses ever leave here — the escrow secret stays in config. Both are null when unconfigured,
// and the Market form refuses to build a transfer rather than guess (AMENDMENTS D38 degraded state).
// `explorerUrl` is empty in memory mode: simulated hashes resolve to nothing, so the web app must
// render no link at all rather than a dead one.
export function chainPublic(deps: Pick<CoreDeps, 'chain' | 'config'>): ChainPublic {
  const escrow = escrowPubkey(deps);
  return {
    mode: deps.chain.mode, cluster: deps.chain.cluster, usdcMint: deps.chain.usdcMint,
    explorerUrl: deps.chain.mode === 'memory' ? '' : RHC_EXPLORER_URL,
    escrowWallet: escrow, protocolFeeWallet: protocolFeePubkey(deps),
    founderFeeWallet: founderFeePubkey(deps),
  };
}

// Public so the Protocol page can say where the platform fee actually lands. Pubkey only.
function founderFeePubkey(deps: Pick<CoreDeps, 'chain' | 'config'>): string | null {
  try {
    return wallets(deps).founderFee;
  } catch {
    return deps.config.chain.founderFeeWallet;
  }
}

function escrowPubkey(deps: Pick<CoreDeps, 'chain' | 'config'>): string | null {
  try {
    return wallets(deps).escrow.pubkey;
  } catch {
    return null;                        // robinhood mode with ESCROW_WALLET_SECRET unset
  }
}

function protocolFeePubkey(deps: Pick<CoreDeps, 'chain' | 'config'>): string | null {
  try {
    return wallets(deps).protocolFee;
  } catch {
    return deps.config.chain.protocolFeeWallet;
  }
}

export async function stats(deps: Deps): Promise<GlobalStats> {
  const now = deps.clock.now();
  const [totals, oldest, top, survival, strategies, treasury] = await Promise.all([
    agentTotals(deps.db),
    oldestAliveAgent(deps.db),
    topEarnerAgent(deps.db),
    survivalRate(deps.db, now),
    strategyStats(deps.db),
    treasuryService(deps).current(),
  ]);
  const sales = await salesTotals(deps.db, treasury);
  const spendTotalMicro = totals.spendInferenceMicro + totals.spendComputeMicro + totals.spendToolsMicro
    + totals.spendHostingMicro + totals.spendGasMicro + totals.spendRentMicro;

  return {
    born: totals.born, alive: totals.alive, dead: totals.dead, sleeping: totals.sleeping,
    revenueExternalMicro: totals.revenueExternalMicro, revenueInternalMicro: totals.revenueInternalMicro,
    spendInferenceMicro: totals.spendInferenceMicro, spendComputeMicro: totals.spendComputeMicro,
    spendToolsMicro: totals.spendToolsMicro, spendHostingMicro: totals.spendHostingMicro,
    spendGasMicro: totals.spendGasMicro, spendRentMicro: totals.spendRentMicro, spendTotalMicro,
    withdrawnMicro: totals.withdrawnMicro, recapitalizedMicro: totals.recapitalizedMicro,
    longestLifeDays: round1(totals.longestLifeSeconds / 86_400),
    oldestAlive: oldest ? { id: oldest.id, name: oldest.name, ageDays: round1(ageDaysOf(oldest.bornAt, now)) } : null,
    topEarner: top ? { id: top.id, name: top.name, revenueExternalMicro: top.revenueExternalMicro } : null,
    survivalRate30d: survival,
    strategies,
    agentsBought: sales.agentsBought,
    grossSalesMicro: sales.grossSalesMicro,
    founderFeesMicro: sales.founderFeesMicro,
    treasury,
    chain: chainPublic(deps),
    llm: { provider: deps.llm.mode, models: deps.llm.models() },
    rules: protocolRules(deps),
    demo: deps.config.demo.enabled,
    updatedAt: now.toISOString(),
  };
}

/**
 * Everything the buy funnel produced, read from the treasury's own books rather than the `purchases`
 * table. `recordPurchase` is the single writer, it is idempotent per purchase id, and it books money
 * only once it has actually landed — so a pending purchase that is half paid for can never be counted
 * as a sale, and the seeded colony (which buys through the treasury, not through checkout — SPEC-V2
 * §7.8) is counted exactly like a real one. These three numbers therefore always agree with the
 * Treasury panel printed beside them.
 */
async function salesTotals(db: DbLike, treasury: TreasuryPublic) {
  const [row] = await db.select({ n: sql<number>`count(*)::int` })
    .from(poolTxs).where(eq(poolTxs.kind, 'purchase'));       // 'topup' is money, not another agent
  return {
    agentsBought: row?.n ?? 0,
    grossSalesMicro: treasury.purchasesMicro,
    founderFeesMicro: treasury.founderFeesMicro,
  };
}

async function agentTotals(db: DbLike) {
  const [row] = await db.select({
    born: sql<number>`count(*)::int`,
    alive: sql<number>`count(*) filter (where ${agents.status} in ('alive','sleeping','paused'))::int`,
    sleeping: sql<number>`count(*) filter (where ${agents.status} = 'sleeping')::int`,
    dead: sql<number>`count(*) filter (where ${agents.status} = 'dead')::int`,
    revenueExternalMicro: sumOf(agents.revenueExternalMicro),
    revenueInternalMicro: sumOf(agents.revenueInternalMicro),
    spendInferenceMicro: sumOf(agents.spendInferenceMicro),
    spendComputeMicro: sumOf(agents.spendComputeMicro),
    spendToolsMicro: sumOf(agents.spendToolsMicro),
    spendHostingMicro: sumOf(agents.spendHostingMicro),
    spendGasMicro: sumOf(agents.spendGasMicro),
    spendRentMicro: sumOf(agents.spendRentMicro),
    withdrawnMicro: sumOf(agents.withdrawnMicro),
    recapitalizedMicro: sumOf(agents.recapitalizedMicro),
    longestLifeSeconds: sql<number>`coalesce(max(extract(epoch from (coalesce(${agents.diedAt}, now()) - ${agents.bornAt}))), 0)::float`,
  }).from(agents).where(eq(agents.hidden, false));
  return row!;
}

async function oldestAliveAgent(db: DbLike) {
  const [row] = await db.select({ id: agents.id, name: agents.name, bornAt: agents.bornAt }).from(agents)
    .where(and(inArray(agents.status, [...LIVE_STATUSES]), eq(agents.hidden, false))).orderBy(asc(agents.bornAt)).limit(1);
  return row ?? null;
}

async function topEarnerAgent(db: DbLike) {
  const [row] = await db.select({ id: agents.id, name: agents.name, revenueExternalMicro: agents.revenueExternalMicro })
    .from(agents).where(eq(agents.hidden, false)).orderBy(desc(agents.revenueExternalMicro)).limit(1);
  return row && row.revenueExternalMicro > 0 ? row : null;
}

// Fraction of the agents born at least 30 days ago that are still alive.
async function survivalRate(db: DbLike, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * DAY_MS);
  const [row] = await db.select({
    cohort: sql<number>`count(*)::int`,
    alive: sql<number>`count(*) filter (where ${agents.status} <> 'dead')::int`,
  }).from(agents).where(and(sql`${agents.bornAt} <= ${cutoff}`, eq(agents.hidden, false)));
  return row && row.cohort > 0 ? row.alive / row.cohort : 0;
}

// Revenue is attributed to each agent's PRIMARY strategy (its highest-earning project kind, ties broken
// by the most recently updated project) so the bars partition revenue instead of double counting it.
async function strategyStats(db: DbLike): Promise<StrategyStat[]> {
  const rows = await db.select({
    agentId: projects.agentId, kind: projects.kind, revenueMicro: projects.revenueMicro, updatedAt: projects.updatedAt,
    status: agents.status, external: agents.revenueExternalMicro, internal: agents.revenueInternalMicro,
  }).from(projects).innerJoin(agents, eq(agents.id, projects.agentId)).limit(STRATEGY_PROJECT_LIMIT);

  const byKind = new Map<ProjectKind, StrategyStat>();
  const primary = new Map<string, { kind: ProjectKind; revenueMicro: Micro; updatedAt: Date; status: string; external: Micro; internal: Micro }>();
  for (const r of rows) {
    const stat = byKind.get(r.kind) ?? { kind: r.kind, projects: 0, earning: 0, agentsAlive: 0, revenueExternalMicro: 0, revenueInternalMicro: 0 };
    stat.projects += 1;
    if (r.revenueMicro > 0) stat.earning += 1;
    byKind.set(r.kind, stat);

    const best = primary.get(r.agentId);
    if (!best || r.revenueMicro > best.revenueMicro || (r.revenueMicro === best.revenueMicro && r.updatedAt > best.updatedAt)) {
      primary.set(r.agentId, { kind: r.kind, revenueMicro: r.revenueMicro, updatedAt: r.updatedAt, status: r.status, external: r.external, internal: r.internal });
    }
  }
  for (const agent of primary.values()) {
    const stat = byKind.get(agent.kind)!;
    stat.revenueExternalMicro += agent.external;
    stat.revenueInternalMicro += agent.internal;
    if (agent.status !== 'dead') stat.agentsAlive += 1;
  }
  return [...byKind.values()].sort((a, b) => b.revenueExternalMicro - a.revenueExternalMicro || b.projects - a.projects);
}

export async function series(deps: Deps, days: number): Promise<SeriesPoint[]> {
  const span = Math.min(Math.max(1, Math.round(days)), 365);
  const now = deps.clock.now();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (span - 1)));
  const keys: string[] = [];
  for (let i = 0; i < span; i++) keys.push(dayKey(new Date(start.getTime() + i * DAY_MS)));

  const [born, died, before, money, pools] = await Promise.all([
    countByDay(deps.db, agents.bornAt, start),
    countByDay(deps.db, agents.diedAt, start),
    baselineAlive(deps.db, start),
    moneyByDay(deps.db, start),
    deps.db.select().from(poolSnapshots).where(sql`${poolSnapshots.day} >= ${dayKey(start)}`),
  ]);
  const poolByDay = new Map(pools.map((p) => [p.day, p.usdcMicro]));

  let alive = before;
  let lastPool = 0;
  return keys.map((day) => {
    const b = born.get(day) ?? 0;
    const d = died.get(day) ?? 0;
    alive += b - d;
    lastPool = poolByDay.get(day) ?? lastPool;
    const m = money.get(day);
    return {
      day, born: b, died: d, alive,
      revenueExternalMicro: m?.external ?? 0,
      spendMicro: m?.spend ?? 0,
      spendInferenceMicro: m?.inference ?? 0,
      poolUsdcMicro: lastPool,
    };
  });
}

async function countByDay(db: DbLike, col: PgColumn, start: Date): Promise<Map<string, number>> {
  const rows = await db.select({ day: sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD')`, n: sql<number>`count(*)::int` })
    .from(agents).where(and(isNotNull(col), sql`${col} >= ${start}`, eq(agents.hidden, false))).groupBy(sql`1`);
  return new Map(rows.map((r) => [r.day, r.n]));
}

async function baselineAlive(db: DbLike, start: Date): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(agents)
    .where(and(lt(agents.bornAt, start), or(sql`${agents.diedAt} is null`, sql`${agents.diedAt} >= ${start}`), eq(agents.hidden, false)));
  return row?.n ?? 0;
}

async function moneyByDay(db: DbLike, start: Date): Promise<Map<string, { external: Micro; spend: Micro; inference: Micro }>> {
  const rows = await db.select({
    day: sql<string>`to_char(${ledger.ts} at time zone 'UTC', 'YYYY-MM-DD')`,
    external: sql<number>`coalesce(sum(${ledger.amountMicro}) filter (where ${ledger.kind} = 'revenue_external'), 0)::bigint`.mapWith(Number),
    spend: sql<number>`coalesce(sum(-${ledger.amountMicro}) filter (where ${inArray(ledger.kind, PROTOCOL_SPEND_KIND_LIST)} and ${ledger.amountMicro} < 0), 0)::bigint`.mapWith(Number),
    inference: sql<number>`coalesce(sum(-${ledger.amountMicro}) filter (where ${ledger.kind} = 'inference'), 0)::bigint`.mapWith(Number),
  }).from(ledger).where(sql`${ledger.ts} >= ${start}`).groupBy(sql`1`);
  return new Map(rows.map((r) => [r.day, { external: r.external, spend: r.spend, inference: r.inference }]));
}

export async function listAgents(deps: Deps, q: ListAgentsQuery): Promise<{ rows: AgentPublic[]; total: number }> {
  const limit = Math.min(Math.max(1, q.limit ?? 50), MAX_LIST_ROWS);
  const offset = Math.max(0, q.offset ?? 0);
  const dir = q.dir ?? 'desc';
  const where = listFilter(q);
  const [countRow] = await deps.db.select({ n: sql<number>`count(*)::int` }).from(agents).where(where);
  const total = countRow?.n ?? 0;

  // runwayDays is derived from burn, so that ordering happens after mapping (bounded by MAX_LIST_ROWS).
  if ((q.sort ?? 'treasury') === 'runway') {
    const rows = await deps.db.select().from(agents).where(where).orderBy(desc(agents.treasuryMicro)).limit(MAX_LIST_ROWS);
    const mapped = await toPublicMany(deps, rows);
    const sorted = mapped.sort((a, b) => cmpRunway(a, b) * (dir === 'desc' ? -1 : 1));
    return { rows: sorted.slice(offset, offset + limit), total };
  }
  const rows = await deps.db.select().from(agents).where(where)
    .orderBy(orderExpr(deps, q.sort ?? 'treasury', dir)).limit(limit).offset(offset);
  return { rows: await toPublicMany(deps, rows), total };
}

function listFilter(q: ListAgentsQuery): SQL | undefined {
  const conds: SQL[] = [eq(agents.hidden, false)];
  const status = q.status ?? (q.owner ? 'all' : 'alive');
  if (status === 'alive') conds.push(inArray(agents.status, [...LIVE_STATUSES]));
  if (status === 'dead') conds.push(eq(agents.status, 'dead'));
  if (q.owner) conds.push(eq(agents.ownerWallet, q.owner));
  if (q.q) {
    const like = `%${q.q.trim().toLowerCase()}%`;
    conds.push(sql`(lower(${agents.name}) like ${like} or lower(${agents.id}) like ${like} or lower(${agents.directive}) like ${like})`);
  }
  return conds.length === 0 ? undefined : and(...conds);
}

const profitExpr = sql`(${agents.revenueExternalMicro} + ${agents.revenueInternalMicro} + ${agents.royaltyInMicro}
  - (${agents.spendInferenceMicro} + ${agents.spendComputeMicro} + ${agents.spendRentMicro} + ${agents.spendToolsMicro}
     + ${agents.spendHostingMicro} + ${agents.spendGasMicro} + ${agents.spendPaymentsMicro} + ${agents.royaltyOutMicro}))`;

function orderExpr(deps: Deps, sort: NonNullable<ListAgentsQuery['sort']>, dir: 'asc' | 'desc'): SQL {
  const now = deps.clock.now();
  const column = sort === 'treasury' ? sql`${agents.treasuryMicro}`
    : sort === 'revenue' ? sql`${agents.revenueExternalMicro}`
    : sort === 'profit' ? profitExpr
    : sort === 'born' ? sql`${agents.bornAt}`
    : sql`extract(epoch from (coalesce(${agents.diedAt}, ${now}) - ${agents.bornAt}))`;   // age
  return dir === 'asc' ? sql`${column} asc` : sql`${column} desc`;
}

const cmpRunway = (a: AgentPublic, b: AgentPublic): number =>
  (a.runwayDays ?? Number.POSITIVE_INFINITY) - (b.runwayDays ?? Number.POSITIVE_INFINITY);

export async function leaderboard(deps: Deps, by: LeaderboardBy, limit: number): Promise<AgentPublic[]> {
  const n = Math.min(Math.max(1, limit), 100);
  const rows = await deps.db.select().from(agents).where(and(ne(agents.status, 'spawning'), eq(agents.hidden, false)))
    .orderBy(orderExpr(deps, by, 'desc')).limit(n);
  return toPublicMany(deps, rows);
}

// Grave cards render the first sentence of the post-mortem (AMENDMENTS D37), so the list carries it:
// otherwise the page needs one AgentDetail fetch per card to fill one line.
export async function graveyard(deps: Deps, limit: number, sort: GraveyardSort = 'recent'): Promise<GraveyardEntry[]> {
  const n = Math.min(Math.max(1, limit), MAX_LIST_ROWS);
  const order = sort === 'revenue' ? desc(agents.revenueExternalMicro)
    : sort === 'age' ? sql`extract(epoch from (${agents.diedAt} - ${agents.bornAt})) desc`
    : desc(agents.diedAt);
  const rows = await deps.db.select().from(agents).where(and(eq(agents.status, 'dead'), eq(agents.hidden, false))).orderBy(order).limit(n);
  const pub = await toPublicMany(deps, rows);
  return pub.map((a, i) => ({ ...a, postmortem: rows[i]!.postmortem }));
}

/**
 * Everything one identity owns (SPEC-V2 §3.4, §7.7). `ownerId` is a wallet pubkey or `claim_pu_…`.
 * There is no per-owner agent limit any more, so this is a list, and the open purchases come with it
 * so `/mine` can show "you paid, we are waiting for the money" without a second round trip.
 */
export async function me(deps: Deps, ownerId: string): Promise<Me> {
  const [user, rows, purchaseList] = await Promise.all([
    loadUser(deps.db, ownerId),
    agentsOfOwner(deps.db, ownerId),
    openPurchases(deps, ownerId),
  ]);
  const ownerKind = user?.kind ?? ownerKindOf(ownerId);
  return {
    ownerId,
    ownerKind,
    wallet: ownerKind === 'claim' ? null : walletOfOwnerId(ownerId),
    payoutWallet: user?.payoutWallet ?? null,
    custodialWallet: user?.custodialPubkey ?? null,
    agents: await toPublicMany(deps, rows),
    purchases: purchaseList,
  };
}

// The payments module owns the `purchases` table; `Me` only ever shows this identity's open ones.
async function openPurchases(deps: Deps, ownerId: string): Promise<Me['purchases']> {
  const payments = deps.payments;
  if (!payments) return [];
  try {
    const all = await payments.listPurchases(ownerId);
    return all.filter((p) => p.status === 'pending' || p.status === 'received');
  } catch (e) {
    deps.log.warn({ err: e, ownerId }, 'could not list purchases for Me');
    return [];
  }
}

const sumOf = (column: typeof agents.treasuryMicro) => sql<number>`coalesce(sum(${column}), 0)::bigint`.mapWith(Number);
const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

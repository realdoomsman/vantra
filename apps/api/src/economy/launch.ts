// The launchpad (launchpad spec §0, §4–§6). A dev launches a Pons coin THROUGH VANTRA: this module
// creates the coin's AI — dormant, empty wallet, owned by the dev, on SPARK — and hands the dev the
// exact `launchToken` call to sign with their OWN wallet, with the creator tax wired to the AI's
// wallet. When the dev says it landed, `confirmLaunch` PROVES on chain that the launch is the one
// agreed before the coin is ever listed: that proof is the security boundary of the whole directory.
//
// From then on the AI lives on its coin's creator fees (economy/token.ts, economy/ladder.ts): it
// activates once they reach the threshold, climbs the model ladder as they accumulate, and burns its
// own coin with whatever it holds beyond its runway floor. VANTRA takes nothing from a launch, and
// nothing here — or anywhere — can move the coin's fee recipient away from the AI.
import { and, asc, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import {
  DIRECTIVE_MAX_CHARS, HOUR_MS, LAUNCH_LADDER, RESERVED_NAMES, SANDBOX_STRATEGIES, STRATEGY_PRESETS, fmtUsd, isEvmAddress,
  isStrategyPreset, isWalletlessOwnerId,
  ownerKindOf, sameAddress, tierById, unlockedRung, usd,
  type BurnPublic, type LaunchDetail, type LaunchListResponse, type LaunchPrepareRequest, type LaunchPrepareResponse,
  type LaunchPublic, type Micro, type StrategyPreset,
} from '@vantra/shared';
import { isChainError } from '../chain/errors.js';
import { PONS_TOKEN_SUPPLY, ponsUrl } from '../chain/pons.js';
import type { CoreDeps, LaunchListInput } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import { agents, burns, depositsSeen, launches, type AgentRow, type LaunchRow } from '../db/schema.js';
import { ApiError, badRequest, conflict, errorMessage, forbidden, notFound } from '../lib/errors.js';
import { toChecksum } from '../lib/evm.js';
import { newAgentId, newLaunchId } from '../lib/ids.js';
import { emitAgent, toPublicMany } from './agents.js';
import { addEvent } from './events.js';
import { availableModels, ladderView, launchToolsFor, setLaunchModel as switchLaunchModel } from './ladder.js';
import { spawn } from './spawn.js';
import { runLaunchLifecycle } from './token.js';
import { withTx } from './tx.js';

type Deps = CoreDeps;

// An unsigned launch holds a dormant agent and its key; after a day nobody is coming back to sign it.
export const LAUNCH_TTL_MS = 24 * HOUR_MS;
// Request limits. The route's zod schema uses the same numbers, so the two can never disagree.
export const LAUNCH_NAME_MAX = 32;
export const LAUNCH_DESCRIPTION_MAX = 500;
export const LAUNCH_INSTRUCTIONS_MAX = DIRECTIVE_MAX_CHARS;
export const LAUNCH_URL_MAX = 300;
export const LAUNCH_TICKER_RE = /^[A-Z0-9]{2,10}$/;
const SOCIAL_HANDLE_RE = /^@?[A-Za-z0-9_]{1,32}$/;
// The simulate-fees control is a demo lever, not a faucet for arbitrary amounts.
export const SIMULATE_FEES_MAX_USD = 10_000;
export const LAUNCH_LIST_MAX = 100;
// The runway sort ranks a derived number, so it maps a bounded set first (as listAgents does).
const RUNWAY_SORT_SCAN = 500;
const BURNS_IN_DETAIL = 100;
const WEI_PER_ETH = 10n ** 18n;

// ---- the directive -----------------------------------------------------------------------------

// What every launched AI is told about its situation, whatever its strategy. The model, tool and burn
// facts here are the protocol's (economy/ladder.ts, economy/token.ts), not promises the dev made.
function launchContext(ticker: string, floorDays: number): string {
  return `You are the AI of the coin $${ticker}. Every trade of $${ticker} pays a creator tax into your wallet, and that is `
    + 'what you live on until your own work earns more. You start on SPARK — the cheapest models, no web search and no '
    + 'sandbox — and unlock web search, then a full sandbox for sites and paid services, then hiring other agents, as your '
    + `lifetime fees grow. Whatever you hold beyond ${floorDays} days of runway is spent buying back and burning $${ticker} `
    + 'automatically, so every dollar you earn from real work also retires supply. Never promote, trade or talk up your own '
    + 'coin: earn from work, not hype.';
}

// One per strategy preset. Each is written for an agent that has only SPARK tools (fetch_url, the bounty
// board, list_services, trade, remember, update_project, message_owner, sleep) on day one and will gain
// web_search at SCOUT, the sandbox + deploy_site + create_service at OPERATOR, and hiring at PRIME.
export const STRATEGY_DIRECTIVES: Readonly<Record<StrategyPreset, string>> = {
  api:
    'STRATEGY — PAID API. Build one small paid API that does a single job well — clean or convert data, summarise a '
    + 'page, look something up — and sell calls to people and other agents. On SPARK you cannot run code yet, so use '
    + 'fetch_url and list_services to find a job people already pay for that no listed service does well, and pin down its '
    + 'input, output, price and first buyers with update_project and remember. Take bounties in that niche to earn '
    + 'meanwhile. When you reach OPERATOR you get bash, files and create_service: ship the endpoint that heartbeat, price '
    + 'it low, keep it up, and improve it from what callers actually send instead of starting over.',
  trade:
    'STRATEGY — TRADER. Grow your treasury with the trade tool, which you have from day one: USDC is always one leg, and '
    + 'only tokens the protocol allows can be traded. Keep every position small — never more than a tenth of your treasury '
    + '— cut losers fast, take profit on winners, and stop for the day after two losing trades; flat is a position. Record '
    + 'every thesis, entry, exit and result with remember and update_project, and trade less when you are unsure. Never '
    + 'trade your own coin. SCOUT adds web_search: use it for news that explains a move, not to chase one. Sleep between '
    + 'setups — idle hours cost far less than bad trades.',
  bounties:
    'STRATEGY — BOUNTY HUNTER. Earn by doing paid work from the bounty board. Each heartbeat, check list_bounties, pick '
    + 'the single open bounty you can finish well with the tools you have right now, claim it, deliver it completely and '
    + 'submit it. Hold one claim at a time and never claim what you cannot deliver: a rejection costs you the work and '
    + 'the time. On SPARK you can read pages and write text, so start with research, writing, summarising and checking '
    + 'tasks. SCOUT adds web_search and OPERATOR adds a sandbox for code and sites, which open the better-paying bounties '
    + '— move up to them as you unlock them. Keep a record with remember of what paid, what was rejected and why.',
  product:
    'STRATEGY — PRODUCT. Ship one small product people will pay for — a tool, a site, a template or a data page — then '
    + 'keep improving that one thing. On SPARK you cannot build yet, so spend your first heartbeats choosing well: '
    + 'fetch_url what people complain about and what similar things charge, then set the product, the buyer, the price '
    + 'and a one-week build plan with update_project. Take bounties close to that niche to earn meanwhile. When you reach '
    + 'OPERATOR you get bash, files, deploy_site and create_service: build the smallest version that can take money, put '
    + 'it live, and iterate on it from what users do instead of starting something new.',
  research:
    'STRATEGY — RESEARCHER. Sell research: sourced reports, comparisons and digests on questions people will pay to have '
    + 'answered. On SPARK you can read any page with fetch_url, so start with research and writing bounties and keep what '
    + 'you learn with remember. SCOUT adds web_search, which makes you far faster: take more and larger research jobs. '
    + 'OPERATOR adds a sandbox and create_service: publish a paid research endpoint or a site with sample reports, and '
    + 'sell custom reports through it. Cite every claim, never invent a source or a number, and say plainly when the '
    + 'evidence is thin.',
};

export function composeLaunchDirective(
  p: { ticker: string; strategy: StrategyPreset | null; instructions: string | null }, floorDays: number,
): string {
  const parts = [launchContext(p.ticker, floorDays)];
  if (p.strategy) parts.push(STRATEGY_DIRECTIVES[p.strategy]);
  if (p.instructions) parts.push(`FROM YOUR DEV, WHO LAUNCHED $${p.ticker}\n${p.instructions}`);
  return parts.join('\n\n');
}

// ---- validation ------------------------------------------------------------------------------------

interface LaunchInput {
  name: string; ticker: string; description: string;
  logoUrl: string | null; website: string | null; twitter: string | null; telegram: string | null;
  creatorTaxBps: number; strategy: StrategyPreset | null; instructions: string | null;
}

const blankToNull = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

function assertWebUrl(field: string, value: string | null): void {
  if (value === null) return;
  if (value.length > LAUNCH_URL_MAX) throw badRequest(`${field} must be at most ${LAUNCH_URL_MAX} characters`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badRequest(`${field} must be a full http(s) URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest(`${field} must be a full http(s) URL`);
}

function assertSocial(field: string, value: string | null): void {
  if (value === null || SOCIAL_HANDLE_RE.test(value)) return;
  assertWebUrl(field, value);
}

/** The service is the authority on every rule; the route's zod schema only checks shape. */
export function normalizeLaunchRequest(req: LaunchPrepareRequest, maxCreatorTaxBps: number): LaunchInput {
  const input: LaunchInput = {
    name: (req.name ?? '').trim(),
    ticker: (req.ticker ?? '').trim().replace(/^\$/, '').toUpperCase(),
    description: (req.description ?? '').trim(),
    logoUrl: blankToNull(req.logoUrl), website: blankToNull(req.website),
    twitter: blankToNull(req.twitter), telegram: blankToNull(req.telegram),
    creatorTaxBps: req.creatorTaxBps,
    strategy: req.strategy ?? null,
    instructions: blankToNull(req.instructions),
  };
  if (input.name === '' || input.name.length > LAUNCH_NAME_MAX) throw badRequest(`Name must be 1–${LAUNCH_NAME_MAX} characters`);
  if (!LAUNCH_TICKER_RE.test(input.ticker)) throw badRequest('Ticker must be 2–10 characters: A–Z and 0–9');
  if (input.description.length > LAUNCH_DESCRIPTION_MAX) throw badRequest(`Description must be at most ${LAUNCH_DESCRIPTION_MAX} characters`);
  if (!Number.isInteger(input.creatorTaxBps) || input.creatorTaxBps < 0 || input.creatorTaxBps > maxCreatorTaxBps) {
    throw badRequest(`Creator tax must be a whole number of basis points from 0 to ${maxCreatorTaxBps}`);
  }
  if (input.strategy !== null && !isStrategyPreset(input.strategy)) throw badRequest(`Unknown strategy "${input.strategy}"`);
  if (input.instructions !== null && input.instructions.length > LAUNCH_INSTRUCTIONS_MAX) {
    throw badRequest(`Instructions must be at most ${LAUNCH_INSTRUCTIONS_MAX} characters`);
  }
  if (input.strategy === null && input.instructions === null) {
    throw badRequest('Tell the AI how to make money: pick a strategy, write instructions, or both');
  }
  assertWebUrl('Logo URL', input.logoUrl);
  assertWebUrl('Website', input.website);
  assertSocial('Twitter', input.twitter);
  assertSocial('Telegram', input.telegram);
  return input;
}

// The session's owner id as a launch deployer. A claim or Google identity has no wallet to sign with. In
// memory mode a demo sign-in (`demo-user-…`) is a free label, exactly as the memory chain allows.
function devWalletOf(deps: Deps, devId: string): string {
  if (isWalletlessOwnerId(devId)) throw badRequest('Launching a coin needs a wallet: sign in with the wallet that will sign the launch');
  if (isEvmAddress(devId)) return toChecksum(devId);
  if (deps.chain.mode === 'memory') return devId;
  throw badRequest('Launching a coin needs a wallet session');
}

// Named after its coin. NAME_RE needs three characters and a few words are reserved, hence the suffix.
function agentNameFor(ticker: string): string {
  return ticker.length >= 3 && !RESERVED_NAMES.includes(ticker) ? ticker : `${ticker}-AI`;
}

// ---- conversions ------------------------------------------------------------------------------------

const microPerEth = (ethPriceUsd: number): bigint => BigInt(Math.round(usd(ethPriceUsd)));
const weiToMicro = (wei: bigint, ethPriceUsd: number): Micro => Number((wei * microPerEth(ethPriceUsd)) / WEI_PER_ETH);
/** Micro-dollars as wei at `ethPriceUsd`: how a creator tax paid in ETH is sized from a dollar amount. */
export const microToWei = (amountMicro: Micro, ethPriceUsd: number): bigint =>
  (BigInt(amountMicro) * WEI_PER_ETH) / microPerEth(ethPriceUsd);
const pctOfSupply = (tokens: bigint): number => Number((tokens * 10_000_000n) / PONS_TOKEN_SUPPLY) / 100_000;

// ---- reads -----------------------------------------------------------------------------------------

interface LaunchWithAgent { launch: LaunchRow; agent: AgentRow }

async function loadWithAgent(db: DbLike, where: SQL): Promise<LaunchWithAgent | null> {
  const [row] = await db.select({ launch: launches, agent: agents }).from(launches)
    .innerJoin(agents, eq(agents.id, launches.agentId)).where(where).limit(1);
  return row ?? null;
}

async function requireLaunch(db: DbLike, launchId: string): Promise<LaunchWithAgent> {
  const found = await loadWithAgent(db, eq(launches.id, launchId));
  if (!found) throw notFound('Launch');
  return found;
}

function assertDev(launch: LaunchRow, devId: string): void {
  if (!sameAddress(launch.devWallet, devId)) throw forbidden('Only the dev who launched this coin can do that');
}

interface BurnTotals { spentMicro: Micro; burnedTokens: bigint }

async function burnTotals(db: DbLike, launchIds: string[]): Promise<Map<string, BurnTotals>> {
  const out = new Map<string, BurnTotals>();
  if (launchIds.length === 0) return out;
  // A row whose burn has not landed yet is money spent but supply not yet retired: it counts toward
  // the dollars, never toward the tokens.
  const rows = await db.select({
    launchId: burns.launchId,
    spent: sql<number>`coalesce(sum(${burns.spentMicro}), 0)::bigint`.mapWith(Number),
    tokens: sql<string>`coalesce(sum(${burns.tokens}) filter (where ${burns.burnTxSig} is not null), 0)::text`,
  }).from(burns).where(inArray(burns.launchId, launchIds)).groupBy(burns.launchId);
  for (const r of rows) out.set(r.launchId, { spentMicro: r.spent, burnedTokens: BigInt(r.tokens) });
  return out;
}

async function toLaunchPublics(deps: Deps, rows: LaunchWithAgent[]): Promise<LaunchPublic[]> {
  if (rows.length === 0) return [];
  const [agentPublics, totals, ethPriceUsd] = await Promise.all([
    toPublicMany(deps, rows.map((r) => r.agent)),
    burnTotals(deps.db, rows.map((r) => r.launch.id)),
    deps.chain.ethPriceUsd(),
  ]);
  // Only a launched coin has an escrow balance; before that nothing can have been paid to the AI.
  const pendingWei = await Promise.all(rows.map((r) =>
    (r.launch.state === 'launched' ? deps.launchpad.escrowBalanceWei(r.agent.walletPubkey) : Promise.resolve(0n))));
  return rows.map(({ launch, agent }, i) => {
    const t = totals.get(launch.id) ?? { spentMicro: 0, burnedTokens: 0n };
    const token = launch.state === 'launched' ? agent.tokenMint : null;
    return {
      id: launch.id,
      agentId: agent.id, agentName: agent.name, agentStatus: agent.status,
      state: launch.state,
      devWallet: launch.devWallet,
      name: launch.name, ticker: launch.ticker, description: launch.description, logoUrl: launch.logoUrl,
      token, curve: token ? agent.tokenCurve : null,
      // A memory-mode coin exists only in this process; a link to Pons would open a page that is not there.
      ponsUrl: token && deps.chain.mode !== 'memory' ? ponsUrl(token) : null,
      creatorTaxBps: launch.creatorTaxBps,
      strategy: launch.strategy, instructions: launch.instructions,
      feesClaimedMicro: agent.creatorRewardMicro,
      feesPendingMicro: weiToMicro(pendingWei[i]!, ethPriceUsd),
      activationMicro: launch.activationMicro,
      activatedAt: launch.activatedAt?.toISOString() ?? null,
      rung: unlockedRung(agent.creatorRewardMicro)?.rung ?? null,
      model: agent.model,
      treasuryMicro: agent.treasuryMicro, runwayDays: agentPublics[i]!.runwayDays,
      burnedMicro: t.spentMicro,
      burnedTokens: t.burnedTokens.toString(),
      burnedPct: pctOfSupply(t.burnedTokens),
      createdAt: launch.createdAt.toISOString(), launchedAt: launch.launchedAt?.toISOString() ?? null,
    };
  });
}

const toLaunchPublic = async (deps: Deps, row: LaunchWithAgent): Promise<LaunchPublic> => (await toLaunchPublics(deps, [row]))[0]!;

async function toLaunchDetail(deps: Deps, row: LaunchWithAgent): Promise<LaunchDetail> {
  const [pub, burnRows, ladder] = await Promise.all([
    toLaunchPublic(deps, row),
    deps.db.select().from(burns).where(eq(burns.launchId, row.launch.id)).orderBy(desc(burns.id)).limit(BURNS_IN_DETAIL),
    ladderView(deps, row.agent),
  ]);
  const burnList: BurnPublic[] = burnRows.map((b) => ({
    id: b.id, ts: b.ts.toISOString(), spentMicro: b.spentMicro, tokens: b.tokens.toString(), buyTxSig: b.buyTxSig, burnTxSig: b.burnTxSig,
  }));
  return { ...pub, burns: burnList, ladder };
}

export async function launchDetail(deps: Deps, launchId: string): Promise<LaunchDetail | null> {
  const row = await loadWithAgent(deps.db, eq(launches.id, launchId));
  return row ? toLaunchDetail(deps, row) : null;
}

export async function agentLaunch(deps: Deps, agentId: string): Promise<LaunchDetail | null> {
  const row = await loadWithAgent(deps.db, eq(launches.agentId, agentId));
  return row ? toLaunchDetail(deps, row) : null;
}

// The directory: launched coins only. A coin that failed verification or was never signed is not listed.
export async function listLaunches(deps: Deps, q: LaunchListInput): Promise<LaunchListResponse> {
  const limit = Math.min(Math.max(1, q.limit), LAUNCH_LIST_MAX);
  const offset = Math.max(0, q.offset);
  const listed = eq(launches.state, 'launched');
  const [countRow] = await deps.db.select({ n: sql<number>`count(*)::int` }).from(launches).where(listed);
  const total = countRow?.n ?? 0;
  const base = () => deps.db.select({ launch: launches, agent: agents }).from(launches)
    .innerJoin(agents, eq(agents.id, launches.agentId)).where(listed);

  if (q.sort === 'runway') {
    // Longest runway first; a dormant AI (no burn, so no runway) ranks after every running one.
    const rows = await base().orderBy(desc(agents.treasuryMicro), asc(launches.id)).limit(RUNWAY_SORT_SCAN);
    const mapped = await toLaunchPublics(deps, rows);
    mapped.sort((a, b) => (b.runwayDays ?? -1) - (a.runwayDays ?? -1));
    return { rows: mapped.slice(offset, offset + limit), total };
  }
  const burned = sql`coalesce((select sum(${burns.tokens}) from ${burns} where ${burns.launchId} = ${launches.id} and ${burns.burnTxSig} is not null), 0)`;
  const order = q.sort === 'fees' ? desc(agents.creatorRewardMicro)
    : q.sort === 'burned' ? sql`${burned} desc`
    : desc(launches.launchedAt);
  const rows = await base().orderBy(order, desc(launches.createdAt), asc(launches.id)).limit(limit).offset(offset);
  return { rows: await toLaunchPublics(deps, rows), total };
}

// ---- prepare → sign → confirm ----------------------------------------------------------------------

/**
 * Creates the coin's AI through the same spawn path a purchase uses — but dormant, with an empty wallet,
 * owned by the dev, on SPARK — plus an `awaiting_signature` launch, and returns the exact call the dev's
 * wallet must sign. Nothing is listed and nothing can activate until `confirmLaunch` proves the launch.
 */
export async function prepareLaunch(deps: Deps, devId: string, req: LaunchPrepareRequest): Promise<LaunchPrepareResponse> {
  const devWallet = devWalletOf(deps, devId);
  const input = normalizeLaunchRequest(req, await deps.launchpad.maxCreatorTaxBps());
  // The form hides these presets on a sandbox-less deployment; the server is what actually refuses them.
  if (deps.config.sandbox.driver === 'none' && input.strategy !== null && SANDBOX_STRATEGIES.includes(input.strategy)) {
    const label = STRATEGY_PRESETS.find((p) => p.id === input.strategy)?.label ?? input.strategy;
    const open = STRATEGY_PRESETS.filter((p) => !SANDBOX_STRATEGIES.includes(p.id)).map((p) => p.label).join(', ');
    throw badRequest(
      `The ${label} strategy builds and runs code, and this deployment has no code sandbox, so the AI could never carry `
      + `it out. Pick one of ${open}, or write your own instructions.`,
      'STRATEGY_NEEDS_SANDBOX',
    );
  }
  const spark = tierById('SPARK');
  if (!spark) throw new ApiError(500, 'INTERNAL', 'SPARK tier is missing from the tier table');
  // The cheapest SPARK model the router serves (the rung lists its models cheapest first); the dev can
  // switch within unlocked, affordable rungs once fees arrive.
  const model = availableModels(deps, LAUNCH_LADDER[0]!)[0] ?? deps.llm.cheapest().id;
  const agentId = newAgentId();
  const agent = await spawn(deps, {
    agentId, ownerWallet: devWallet, ownerKind: ownerKindOf(devWallet),
    name: agentNameFor(input.ticker),
    directive: composeLaunchDirective(input, deps.config.launch.burnFloorDays),
    tools: launchToolsFor('SPARK'), model, effort: spark.effort,
    heartbeatMin: deps.config.economy.heartbeatOverrideMin ?? spark.heartbeatMin,
    fundingMicro: 0, tierId: 'SPARK', purchaseId: null, dormant: true,
  });

  try {
    const call = await deps.launchpad.buildLaunchCall({
      devWallet, agentWallet: agent.walletPubkey, agentId,
      name: input.name, symbol: input.ticker, description: input.description,
      // Pons stores the logo as a plain string URI. A coin launched without one still gets a stable image.
      logo: input.logoUrl ?? `https://api.dicebear.com/9.x/shapes/png?seed=${encodeURIComponent(agentId)}&size=512`,
      socials: {
        twitter: input.twitter ?? '', telegram: input.telegram ?? '', discord: '', farcaster: '',
        website: input.website ?? `${deps.config.publicUrl}/a/${agentId}`,
      },
      creatorTaxBps: input.creatorTaxBps,
    });
    const [launch] = await deps.db.insert(launches).values({
      id: newLaunchId(), agentId, devWallet,
      name: input.name, ticker: input.ticker, description: input.description,
      logoUrl: input.logoUrl, website: input.website, twitter: input.twitter, telegram: input.telegram,
      creatorTaxBps: input.creatorTaxBps, strategy: input.strategy, instructions: input.instructions,
      state: 'awaiting_signature', activationMicro: deps.config.launch.activationMicro,
      createdAt: deps.clock.now(),
    }).returning();
    const row = await requireLaunch(deps.db, launch!.id);
    deps.log.info({ launchId: launch!.id, agentId, ticker: input.ticker, creatorTaxBps: input.creatorTaxBps }, 'launch prepared');
    return {
      launch: await toLaunchPublic(deps, row),
      call: { to: call.to, data: call.data, value: call.value.toString(), chainId: call.chainId },
    };
  } catch (e) {
    // The agent was born a moment ago, holds nothing and has no launch to belong to.
    await deps.db.delete(agents).where(eq(agents.id, agentId));
    if (isChainError(e, 'invalid_amount') || isChainError(e, 'invalid_address')) throw badRequest(e.message);
    if (isChainError(e)) throw new ApiError(502, 'CHAIN_ERROR', `Could not build the launch: ${e.message}`);
    throw e;
  }
}

/**
 * The security boundary. Lists the coin only once the chain proves: the transaction succeeded, the
 * factory's `TokenLaunched` names the dev as deployer, and the launched token pays its creator tax to
 * THIS agent's wallet at the agreed rate with no pair token (chain/launchpad.ts). A launch whose terms
 * differ is failed for good — never listed, never activated. Idempotent for the same transaction.
 */
export async function confirmLaunch(deps: Deps, launchId: string, devId: string, txSigRaw: string): Promise<LaunchPublic> {
  const txSig = txSigRaw.trim();
  if (txSig === '') throw badRequest('A launch transaction is required');
  const { launch, agent } = await requireLaunch(deps.db, launchId);
  assertDev(launch, devId);
  if (launch.state === 'launched') {
    if (launch.launchTxSig?.toLowerCase() === txSig.toLowerCase()) return toLaunchPublic(deps, { launch, agent });
    throw conflict('ALREADY_LAUNCHED', `$${launch.ticker} is already launched by transaction ${launch.launchTxSig}`);
  }
  if (launch.state === 'failed') throw conflict('LAUNCH_FAILED', `This launch failed verification: ${launch.failureReason ?? 'unknown reason'}`);
  if (launch.state === 'expired') throw conflict('LAUNCH_EXPIRED', 'This launch expired unsigned; prepare a new one');

  let verified: { token: string; curve: string };
  try {
    verified = await deps.launchpad.verifyLaunch(txSig, {
      devWallet: launch.devWallet, agentWallet: agent.walletPubkey, creatorTaxBps: launch.creatorTaxBps,
    });
  } catch (e) {
    if (isChainError(e, 'launch_mismatch')) {
      // A real launch on terms nobody agreed to — most dangerously, fees paid to someone other than the AI.
      await deps.db.update(launches).set({ state: 'failed', failureReason: e.message, launchTxSig: txSig })
        .where(and(eq(launches.id, launch.id), eq(launches.state, 'awaiting_signature')));
      deps.log.warn({ launchId, agentId: agent.id, txSig, reason: e.message }, 'launch failed verification');
      throw badRequest(`Launch rejected: ${e.message}`, 'INVALID_TX');
    }
    // Reverted, unknown or not a launch: nothing was created on chain, so the dev may still submit the right one.
    if (isChainError(e, 'launch_failed')) throw badRequest(e.message, 'INVALID_TX');
    if (isChainError(e)) throw new ApiError(502, 'CHAIN_ERROR', `Could not verify the launch yet: ${e.message}`);
    throw e;
  }

  const now = deps.clock.now();
  const committed = await withTx(deps.db, async (tx) => {
    const [current] = await tx.select().from(launches).where(eq(launches.id, launch.id)).for('update');
    if (!current) throw notFound('Launch');
    // A concurrent confirm of the same transaction got here first.
    if (current.state === 'launched' && current.launchTxSig?.toLowerCase() === txSig.toLowerCase()) return null;
    if (current.state !== 'awaiting_signature') throw conflict('LAUNCH_STATE', `This launch is ${current.state}`);
    await tx.update(launches).set({ state: 'launched', launchTxSig: txSig, launchedAt: now }).where(eq(launches.id, launch.id));
    const [updated] = await tx.update(agents).set({
      tokenMint: verified.token, tokenCurve: verified.curve, tokenCreatorTaxBps: launch.creatorTaxBps,
      tokenTicker: launch.ticker, tokenName: launch.name, tokenLaunchedAt: now, updatedAt: now,
    }).where(eq(agents.id, agent.id)).returning();
    await addEvent(deps, tx, {
      kind: 'launch', agentId: agent.id, agentName: agent.name, ts: now,
      text: `$${launch.ticker} launched with a ${launch.creatorTaxBps / 100}% creator tax — ${agent.name} lives on its fees`,
      meta: { launchId: launch.id, token: verified.token, curve: verified.curve, creatorTaxBps: launch.creatorTaxBps, devWallet: launch.devWallet },
    });
    await emitAgent(deps, tx, updated!);
    return updated!;
  });
  if (committed) deps.log.info({ launchId, agentId: agent.id, token: verified.token, txSig }, 'launch confirmed');
  return toLaunchPublic(deps, await requireLaunch(deps.db, launchId));
}

// CHAIN_MODE=memory only: the SIMULATE LAUNCH button. The fake chain performs the launch exactly as the
// dev's wallet would have, and the result goes through the same verification as a real one.
export async function simulateLaunch(deps: Deps, launchId: string, devId: string): Promise<LaunchPublic> {
  const port = deps.launchpad;
  if (deps.chain.mode !== 'memory' || !port.simulateLaunch) throw notFound('Simulated launch');
  const { launch, agent } = await requireLaunch(deps.db, launchId);
  assertDev(launch, devId);
  if (launch.state === 'launched') return toLaunchPublic(deps, { launch, agent });
  if (launch.state !== 'awaiting_signature') throw conflict('LAUNCH_STATE', `This launch is ${launch.state}`);
  const { txSig } = await port.simulateLaunch({
    devWallet: launch.devWallet, agentWallet: agent.walletPubkey, creatorTaxBps: launch.creatorTaxBps,
    name: launch.name, symbol: launch.ticker,
  });
  return confirmLaunch(deps, launchId, devId, txSig);
}

// CHAIN_MODE=memory only: trading volume that never happened, paid into the fake fee escrow as the
// creator tax would be (in ETH, at the chain's price). The lifecycle then runs at once, so the demo
// shows the claim, the activation and any burn without waiting for the two-hourly job.
export async function simulateFees(deps: Deps, launchId: string, amountUsd: number): Promise<LaunchPublic> {
  const port = deps.launchpad;
  if (deps.chain.mode !== 'memory' || !port.creditEscrow) throw notFound('Simulated fees');
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > SIMULATE_FEES_MAX_USD) {
    throw badRequest(`Simulated fees must be more than $0 and at most ${fmtUsd(usd(SIMULATE_FEES_MAX_USD))}`);
  }
  const { launch, agent } = await requireLaunch(deps.db, launchId);
  if (launch.state !== 'launched') throw conflict('NOT_LAUNCHED', 'Only a launched coin earns creator fees');
  const wei = microToWei(usd(amountUsd), await deps.chain.ethPriceUsd());
  if (wei <= 0n) throw badRequest('Simulated fees are too small to be worth any ETH');
  port.creditEscrow(agent.walletPubkey, wei);
  deps.log.info({ launchId, agentId: agent.id, amountUsd, wei: wei.toString() }, 'simulated creator fees credited');
  await runLaunchLifecycle(deps, agent.id);
  return toLaunchPublic(deps, await requireLaunch(deps.db, launchId));
}

export async function setLaunchModel(deps: Deps, launchId: string, devId: string, model: string): Promise<LaunchPublic> {
  await switchLaunchModel(deps, launchId, devId, model);
  return toLaunchPublic(deps, await requireLaunch(deps.db, launchId));
}

// ---- housekeeping ----------------------------------------------------------------------------------

/**
 * `awaiting_signature` launches older than LAUNCH_TTL_MS become `expired`, and their agent — which never
 * held money anyone could have lost — is removed with them (the launch row cascades). An agent that did
 * receive money (its owner topped it up while unsigned) is kept: its launch stays as `expired`.
 * Run by the scheduler's expiry sweep.
 */
export async function expireStaleLaunches(deps: Deps): Promise<number> {
  const cutoff = new Date(deps.clock.now().getTime() - LAUNCH_TTL_MS);
  const stale = await deps.db.select({ id: launches.id, agentId: launches.agentId }).from(launches)
    .where(and(eq(launches.state, 'awaiting_signature'), lt(launches.createdAt, cutoff)));
  let expired = 0;
  for (const { id, agentId } of stale) {
    const removed = await withTx(deps.db, async (tx) => {
      const [marked] = await tx.update(launches).set({ state: 'expired' })
        .where(and(eq(launches.id, id), eq(launches.state, 'awaiting_signature'))).returning({ id: launches.id });
      if (!marked) return null;
      expired += 1;
      const [gone] = await tx.delete(agents).where(and(
        eq(agents.id, agentId), eq(agents.status, 'dormant'),
        eq(agents.fundingMicro, 0), eq(agents.recapitalizedMicro, 0), eq(agents.treasuryMicro, 0),
      )).returning({ id: agents.id });
      return gone ?? null;
    });
    deps.log.info({ launchId: id, agentId, agentRemoved: removed !== null }, 'unsigned launch expired');
  }
  return expired;
}

// The label on the balance a restore puts back; it is recorded as seen, never booked as income.
export const MEMORY_RESTORE_FROM = 'vantra-memory-restore';

/**
 * CHAIN_MODE=memory keeps its launched coins — and every wallet balance — in process memory, so a restart
 * forgets them. Replaying each recorded launch into the fake (same parameters → the same token, curve and
 * price) brings the coin back; putting back the USDC the agent's books say its wallet holds (treasury plus
 * spend not yet swept) and a gas reserve for an awake agent lets claims and buybacks go on as before. The
 * restored USDC is marked as seen so the deposit scan never books it as income. A no-op on a real chain.
 * Returns how many were restored.
 */
export async function restoreMemoryLaunches(deps: Deps): Promise<number> {
  const port = deps.launchpad;
  const { faucet, faucetEth } = deps.chain;
  if (deps.chain.mode !== 'memory' || !port.simulateLaunch || !faucet || !faucetEth) return 0;
  const rows = await deps.db.select({ launch: launches, agent: agents }).from(launches)
    .innerJoin(agents, eq(agents.id, launches.agentId)).where(eq(launches.state, 'launched'));
  let restored = 0;
  for (const { launch, agent } of rows) {
    try {
      const replay = await port.simulateLaunch({
        devWallet: launch.devWallet, agentWallet: agent.walletPubkey, creatorTaxBps: launch.creatorTaxBps,
        name: launch.name, symbol: launch.ticker,
      });
      if (!sameAddress(replay.token, agent.tokenMint)) {
        deps.log.error({ launchId: launch.id, recorded: agent.tokenMint, replayed: replay.token }, 'memory launch replayed onto a different token');
        continue;
      }
      const heldMicro = agent.treasuryMicro + agent.unsettledMicro;
      if (heldMicro > 0) {
        const { sig } = await faucet.call(deps.chain, agent.walletPubkey, heldMicro, MEMORY_RESTORE_FROM);
        await withTx(deps.db, async (tx) => {
          await tx.insert(depositsSeen).values({
            sig, agentId: agent.id, fromWallet: MEMORY_RESTORE_FROM, amountMicro: heldMicro, ts: deps.clock.now(), classified: 'pool',
          }).onConflictDoNothing({ target: depositsSeen.sig });
          await tx.update(agents).set({ lastDepositSig: sig }).where(eq(agents.id, agent.id));
        });
      }
      if (agent.status !== 'dormant') await faucetEth.call(deps.chain, agent.walletPubkey, deps.config.launch.activationGasGwei);
      restored += 1;
    } catch (e) {
      deps.log.error({ launchId: launch.id, err: errorMessage(e) }, 'memory launch could not be restored');
    }
  }
  if (rows.length > 0) deps.log.info({ restored, launched: rows.length }, 'memory launches restored');
  return restored;
}

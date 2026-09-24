// The user turn of every heartbeat: a STATUS report, the owner's directive, and "Decide and act."
// SPEC §8.8 with the carry-over of AMENDMENTS B16 (work tree, NOTES.md, recent steps, last tools),
// capped at STATUS_MAX_CHARS so a fat sandbox can never blow up the context. A launchpad agent also
// sees its coin: the fees it has claimed, what is waiting in escrow, and the next rung of the ladder.
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  DAY_MS, HOSTING_PER_DAY_MICRO, HOUR_MS, LAUNCH_LADDER, RENT_SLEEP_PER_HOUR_MICRO, STATUS_MAX_CHARS, fmtUsd, unlockedRung,
  type AgentPublic,
} from '@vantra/shared';
import { gweiToMicro } from '../chain/price.js';
import type { CoreDeps, LlmContent, LlmMessage } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import { bounties, deployments, ownerMessages, projects, services, steps, type AgentRow, type LaunchRow } from '../db/schema.js';
import { activeDeploymentCount, toPublicOne } from '../economy/agents.js';
import { launchedLaunchOf } from '../economy/ladder.js';
import { rentPerHour } from '../economy/burn.js';
import { serviceEndpoint, siteUrl } from '../economy/mappers.js';
import { ownerPrivate } from '../lib/ownerPrivate.js';
import type { Deposit } from './deposits.js';
import { NOTES_PATH } from './prompts.js';

export const FILE_TREE_MAX_CHARS = 1_500;
export const NOTES_MAX_CHARS = 4_000;
export const RECENT_STEPS = 3;
export const MAX_MEMORY_NOTES_SHOWN = 20;
export const BOUNTY_TITLE_STATUS_CHARS = 90;

type Deps = Pick<CoreDeps, 'db' | 'clock' | 'config' | 'chain' | 'launchpad' | 'llm' | 'bus' | 'sandbox' | 'log'>;

export interface StatusOptions {
  deposits: Deposit[];
  aboutToDie: boolean;
  modelId: string;             // the model actually resolved for this step
}
export interface StepContext { text: string; status: Record<string, unknown>; pub: AgentPublic }

export async function buildContext(deps: Deps, agent: AgentRow, opts: StatusOptions): Promise<StepContext> {
  const pub = await toPublicOne(deps, agent);
  // No sandbox, no /work: the STATUS report says nothing about a workspace the agent does not have.
  const sandbox = deps.config.sandbox.driver !== 'none';
  const [tree, notes, recent, projectRows, serviceRows, memoryNotes, market, messages, site, sites, launch] = await Promise.all([
    sandbox ? fileTree(deps, agent.id) : null,
    sandbox ? readNotes(deps, agent.id) : null,
    recentSteps(deps.db, agent.id),
    deps.db.select().from(projects).where(eq(projects.agentId, agent.id)).orderBy(desc(projects.updatedAt)).limit(8),
    deps.db.select().from(services).where(eq(services.agentId, agent.id)).orderBy(desc(services.createdAt)).limit(8),
    Promise.resolve(shownMemory(agent.memory)),
    marketSnapshot(deps.db, agent.id),
    newOwnerMessages(deps.db, agent.id, agent.lastStepAt),
    activeSite(deps, agent),
    activeDeploymentCount(deps.db, agent.id),
    launchedLaunchOf(deps.db, agent.id),
  ]);

  const status: Record<string, unknown> = {
    you: {
      name: agent.name, step: agent.totalSteps + 1, age_days: pub.ageDays, model: opts.modelId, effort: agent.effort,
      heartbeat_min: agent.heartbeatMin, status: agent.status, phase: pub.phase,
    },
    survival: survivalBlock(deps, agent, pub, sites, launch !== null),
    money: {
      treasury: fmtUsd(agent.treasuryMicro), unsettled_spend: fmtUsd(agent.unsettledMicro),
      burn_per_day: fmtUsd(pub.burnPerDayMicro), runway_days: pub.runwayDays,
      external_revenue: fmtUsd(agent.revenueExternalMicro), internal_revenue: fmtUsd(agent.revenueInternalMicro),
      funding: fmtUsd(agent.fundingMicro), paid_back: pub.paidBack, profit: fmtUsd(pub.profitMicro),
    },
    ...(launch ? { coin: await coinBlock(deps, agent, launch) } : {}),
    wallet: {
      pubkey: agent.walletPubkey, cluster: deps.chain.cluster, usdc_mint: deps.chain.usdcMint,
      profile_url: `${deps.config.publicUrl}/a/${agent.id}`, site_url: site,
    },
    ...(sandbox ? { work: { tree, notes_md: notes } } : {}),
    projects: projectRows.map((p) => ({ id: p.id, name: p.name, kind: p.kind, status: p.status, url: p.url, revenue: fmtUsd(p.revenueMicro) })),
    services: serviceRows.map((s) => ({
      id: s.id, name: s.name, price: fmtUsd(s.priceMicro), endpoint_url: serviceEndpoint(deps.config, s.id),
      status: s.status, calls: s.calls, revenue: fmtUsd(s.revenueMicro),
    })),
    memory: memoryNotes,
    market,
    recent_steps: recent.summaries,
    last_step_tools: recent.tools,
    new_deposits: opts.deposits.map((d) => ({ amount: fmtUsd(d.amountMicro), kind: d.classified, memo: d.memo })),
    owner_messages: messages,
    about_to_die: opts.aboutToDie,
  };

  const text = [
    `STATUS\n${fit(status)}`,
    `Directive from your owner: "${agent.directive}"`,
    opts.aboutToDie
      ? launch
        ? 'You cannot afford another full heartbeat. This is your last turn before you go dormant: no tools, just say what '
          + "you built, what you learned and what you will do when your coin's fees wake you. It is published on your profile."
        : 'You cannot afford another full heartbeat. This is your last turn: no tools, just say what you built, what you '
          + 'learned and what you would do differently. It is published on your profile.'
      : 'Decide and act.',
  ].join('\n\n');

  return { text, status, pub };
}

// SPEC-V2 §7.3. The one number an agent is supposed to move, said plainly and put above the money
// block so it survives every truncation. `floor_per_day` is what merely existing costs — rent plus
// hosting — so "sleep more" is visibly not a way to live forever.
export function survivalBlock(
  deps: Pick<CoreDeps, 'config' | 'clock'>, agent: AgentRow, pub: AgentPublic, sites: number, launched: boolean,
): Record<string, unknown> {
  const rates = { rentAlivePerHour: deps.config.economy.rentPerHourMicro, rentSleepPerHour: RENT_SLEEP_PER_HOUR_MICRO, hostingPerDay: HOSTING_PER_DAY_MICRO };
  const floorPerDayMicro = Math.round(rentPerHour(agent.status, rates) * (DAY_MS / HOUR_MS) + sites * HOSTING_PER_DAY_MICRO);
  const days = pub.runwayDays;
  const diesOn = days === null ? null : new Date(deps.clock.now().getTime() + days * DAY_MS);
  return {
    days_of_life_left: days,
    dies_on: diesOn?.toISOString() ?? null,
    treasury: fmtUsd(agent.treasuryMicro),
    burn_per_day: fmtUsd(pub.burnPerDayMicro),
    floor_per_day: fmtUsd(floorPerDayMicro),
    note: days === null || diesOn === null
      ? 'You are not burning anything measurable right now, so there is no death date. That changes the moment you think.'
      : launched
        ? `At the current burn you have ${days} days left. You go dormant on ${diesOn.toISOString().slice(0, 10)} unless money `
          + "arrives, and stay dormant until your coin's fees wake you."
        : `At the current burn you have ${days} days left. You die on ${diesOn.toISOString().slice(0, 10)} unless money arrives.`,
  };
}

// What a launchpad agent should know about its coin, every heartbeat. The escrow read is best-effort: a
// flaky RPC must never cost the agent its step.
async function coinBlock(deps: Deps, agent: AgentRow, launch: LaunchRow): Promise<Record<string, unknown>> {
  const rung = unlockedRung(agent.creatorRewardMicro);
  const next = LAUNCH_LADDER.find((s) => s.unlockMicro > agent.creatorRewardMicro) ?? null;
  const waitingMicro = await Promise.all([deps.launchpad.escrowBalanceWei(agent.walletPubkey), deps.chain.ethPriceUsd()])
    .then(([wei, price]) => gweiToMicro(Number(wei / 1_000_000_000n), price))
    .catch(() => null);
  return {
    ticker: `$${launch.ticker}`,
    creator_tax_pct: launch.creatorTaxBps / 100,
    fees_claimed: fmtUsd(agent.creatorRewardMicro),
    fees_waiting_in_escrow: waitingMicro === null ? 'unknown' : fmtUsd(waitingMicro),
    rung: rung?.rung ?? 'none yet',
    next_rung: next ? { rung: next.rung, unlocks_at_fees: fmtUsd(next.unlockMicro) } : 'top of the ladder',
    note: 'Fees are claimed into your treasury automatically. Everything above your runway floor is spent buying back and '
      + 'burning this coin automatically. Your dev chooses your model; stronger models and tools unlock as fees grow.',
  };
}

// STATUS shows only the newest notes, but `forget(index)` addresses the FULL array — so the index the
// agent reads must be the absolute one, or a 21st note silently shifts every deletion by the offset.
export function shownMemory(memory: string[]): { i: number; note: string }[] {
  const offset = Math.max(0, memory.length - MAX_MEMORY_NOTES_SHOWN);
  return memory.slice(offset).map((note, i) => ({ i: offset + i, note }));
}

export const userTurn = (text: string): LlmMessage => ({ role: 'user', content: [{ type: 'text', text }] });

// Appends a system reminder to the last user message (round cap, SPEC §8.5).
export function appendReminder(messages: LlmMessage[], reminder: string): void {
  const block: LlmContent = { type: 'text', text: `<system-reminder>${reminder}</system-reminder>` };
  const last = messages.at(-1);
  if (last?.role === 'user') last.content.push(block);
  else messages.push({ role: 'user', content: [block] });
}

// Drops the biggest optional blocks until STATUS fits (B16). SPEC-V2 §7.3 reorders this so the
// model's own memory is the LAST thing sacrificed, and `survival` is never droppable at all.
export function fit(status: Record<string, unknown>): string {
  const droppable = ['recent_steps', 'projects', 'memory', 'work.tree', 'work.notes_md'];
  const copy = structuredClone(status);
  let text = JSON.stringify(copy, null, 1);
  for (const path of droppable) {
    if (text.length <= STATUS_MAX_CHARS) break;
    drop(copy, path);
    text = JSON.stringify(copy, null, 1);
  }
  return text.length <= STATUS_MAX_CHARS ? text : `${text.slice(0, STATUS_MAX_CHARS)}\n…[status truncated]`;
}

function drop(obj: Record<string, unknown>, path: string): void {
  const [head, tail] = path.split('.') as [string, string | undefined];
  if (tail) {
    const inner = obj[head];
    if (inner && typeof inner === 'object') (inner as Record<string, unknown>)[tail] = '(omitted: status too long)';
    return;
  }
  obj[head] = '(omitted: status too long)';
}

// Depth-2 listing of /work. Free: it costs no tool call and no ledger row.
async function fileTree(deps: Deps, agentId: string): Promise<string> {
  try {
    const top = await deps.sandbox.listFiles(agentId, '.');
    const lines: string[] = [];
    for (const entry of top.slice(0, 40)) {
      lines.push(entry.dir ? `${entry.path}/` : `${entry.path} (${entry.bytes}b)`);
      if (!entry.dir) continue;
      const children = await deps.sandbox.listFiles(agentId, entry.path).catch(() => []);
      for (const child of children.slice(0, 20)) lines.push(`  ${child.path}${child.dir ? '/' : ` (${child.bytes}b)`}`);
    }
    const text = lines.join('\n');
    return text.length > FILE_TREE_MAX_CHARS ? `${text.slice(0, FILE_TREE_MAX_CHARS)}\n…` : text || '(empty)';
  } catch (e) {
    deps.log.debug({ err: e, agentId }, 'file tree unavailable');
    return '(sandbox unavailable)';
  }
}

async function readNotes(deps: Deps, agentId: string): Promise<string | null> {
  try {
    const text = await deps.sandbox.readFile(agentId, NOTES_PATH, NOTES_MAX_CHARS);
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

interface RecentSteps {
  summaries: { n: number; status: string; stop: string | null; summary: string }[];
  tools: { name: string; ok: boolean }[];
}

async function recentSteps(db: DbLike, agentId: string): Promise<RecentSteps> {
  const rows = await db.select().from(steps).where(and(eq(steps.agentId, agentId), sql`${steps.status} <> 'running'`))
    .orderBy(desc(steps.id)).limit(RECENT_STEPS);
  return {
    summaries: rows.map((r) => ({ n: r.n, status: r.status, stop: r.stopReason, summary: r.summary || r.error || '' })),
    tools: toolCallsOf(rows[0]?.transcript ?? null),
  };
}

// Tool names and error flags of the previous step, read back out of its transcript (B16).
function toolCallsOf(transcript: LlmMessage[] | null): { name: string; ok: boolean }[] {
  if (!transcript) return [];
  const names = new Map<string, string>();
  const out: { name: string; ok: boolean }[] = [];
  for (const message of transcript) {
    for (const block of message.content) {
      if (block.type === 'tool_use') names.set(block.id, block.name);
      if (block.type === 'tool_result') out.push({ name: names.get(block.toolUseId) ?? 'tool', ok: block.isError !== true });
    }
  }
  return out.slice(-12);
}

async function marketSnapshot(db: DbLike, agentId: string): Promise<Record<string, unknown>> {
  const [open] = await db.select({ n: sql<number>`count(*)::int` }).from(bounties).where(eq(bounties.status, 'open'));
  const mine = await db.select({ id: bounties.id, title: bounties.title, status: bounties.status, rewardMicro: bounties.rewardMicro, deadlineAt: bounties.deadlineAt })
    .from(bounties).where(and(eq(bounties.claimerAgentId, agentId), inArray(bounties.status, ['claimed', 'submitted']))).limit(3);
  return {
    open_bounties: open?.n ?? 0,
    my_claims: mine.map((b) => ({
      id: b.id,
      // Titles are written by strangers (any signed-in wallet, any agent). STATUS is the protocol's
      // own report — the one region the system prompt tells the model to trust — so third-party text
      // is neutralised and labelled here. The full text comes back through list_bounties, wrapped.
      title_untrusted: outsideText(b.title, BOUNTY_TITLE_STATUS_CHARS),
      status: b.status, reward: fmtUsd(b.rewardMicro), deadline: b.deadlineAt.toISOString(),
    })),
  };
}

// Strips the characters an injected string would need to forge the <untrusted> framing, flattens
// newlines so it cannot fake a new JSON line, and clips it.
export function outsideText(text: string, maxChars: number): string {
  const flat = text.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}

// Each message is delimited so the public transcript view can strip it without parsing STATUS (C21).
async function newOwnerMessages(db: DbLike, agentId: string, since: Date | null): Promise<string[]> {
  const rows = await db.select({ text: ownerMessages.text }).from(ownerMessages)
    .where(and(eq(ownerMessages.agentId, agentId), eq(ownerMessages.fromRole, 'owner'), since ? gt(ownerMessages.ts, since) : undefined))
    .orderBy(desc(ownerMessages.id)).limit(5);
  return rows.map((r) => ownerPrivate(r.text)).reverse();
}

async function activeSite(deps: Deps, agent: AgentRow): Promise<string | null> {
  const [row] = await deps.db.select({ slug: deployments.slug }).from(deployments)
    .where(and(eq(deployments.agentId, agent.id), eq(deployments.active, true))).orderBy(desc(deployments.id)).limit(1);
  return row ? siteUrl(deps.config, row.slug) : null;
}


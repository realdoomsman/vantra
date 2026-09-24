// Spawning an agent (SPEC-V2 §7.1). v2 has no holding gate, no one-agent-per-wallet rule and no seed
// pool: an agent exists because someone paid for it, and the money is already in the treasury by the
// time this runs. Everything here is therefore written so that a paid purchase ALWAYS produces an
// agent — a taken name is deduped rather than refused, an unavailable model falls back to the
// cheapest one, and a failed funding transfer leaves the row retryable instead of dead.
import { eq } from 'drizzle-orm';
import {
  DEFAULT_HEARTBEAT_MIN, DIRECTIVE_MAX_CHARS, LAUNCH_DIRECTIVE_MAX_CHARS, MAX_HEARTBEAT_MIN, MIN_HEARTBEAT_MIN, NAME_RE,
  fmtUsd, isEffort, isToolName, slugify, validateName, type AgentPublic, type Micro, type ToolName,
} from '@vantra/shared';
import type { CoreDeps, SpawnInput } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import { agents, depositsSeen, purchases, type AgentRow, type NewAgent } from '../db/schema.js';
import { badRequest, conflict, errorMessage, internal, uniqueViolation } from '../lib/errors.js';
import { isId, newAgentId } from '../lib/ids.js';
import { emitAgent, toPublicOne } from './agents.js';
import { addDecision, addEvent } from './events.js';
import { forkMemory, loadForkParent, recordFork } from './fork.js';
import { post } from './ledger.js';
import { ensureUser } from './repo.js';
import { treasuryService } from './treasury.js';
import { withTx } from './tx.js';
import { saveAgentKey, wallets } from './wallets.js';

export const MAX_FUNDING_ATTEMPTS = 3;
export const NAME_SUFFIX_ATTEMPTS = 8;          // NAME-2 … NAME-9
export const RANDOM_NAME_ATTEMPTS = 4;
const NAME_MAX_CHARS = 16;
// DEMO=1 draws agent keys from a seeded sequence so a colony replays identically; after a restart that
// sequence starts over, so its first draws are wallets existing agents already own.
const MAX_KEY_DRAWS = 10_000;

type Deps = CoreDeps;

async function unusedKeypair(deps: Deps): Promise<{ pubkey: string; secret: Uint8Array }> {
  for (let i = 0; i < MAX_KEY_DRAWS; i++) {
    const keypair = deps.chain.newKeypair();
    const [owner] = await deps.db.select({ id: agents.id }).from(agents).where(eq(agents.walletPubkey, keypair.pubkey)).limit(1);
    if (!owner) return keypair;
  }
  throw internal(`No unused agent wallet after ${MAX_KEY_DRAWS} key draws`);
}

export async function spawn(deps: Deps, input: SpawnInput): Promise<AgentPublic> {
  const { name, model } = validateSpawnInput(deps, input);
  const now = deps.clock.now();

  const parent = input.forkOf ? await loadForkParent(deps.db, input.forkOf) : null;
  const keypair = await unusedKeypair(deps);
  const id = input.agentId && isId(input.agentId, 'ag') ? input.agentId : newAgentId();

  const { agent: created, renamedFrom } = await insertWithDedupe(deps, {
    input, id, name, model, parent, keypair, now,
    // Only a free spawn (the demo colony) may be refused for a taken name. A paid purchase is
    // renamed instead: the buyer's money must never fail to produce an agent. A launch's agent is
    // named after its ticker, which the dev never chose as an agent name, so it is renamed too.
    allowRename: input.purchaseId !== null || input.dormant === true,
  });
  if (renamedFrom) deps.log.warn({ agentId: id, renamedFrom, name: created.name }, 'agent renamed: the name was taken at insert time');

  // A launch's agent has nothing to fund and nothing to run until its coin's fees arrive; the launch
  // lifecycle (economy/ladder.ts) wakes it. Everything above — name, key, directive, birth — is shared.
  if (input.dormant) {
    await emitAgent(deps, deps.db, created);
    deps.log.info({ agentId: id, name: created.name, tier: created.tier }, 'dormant launch agent created');
    return toPublicOne(deps, created);
  }
  const funded = await fundAndActivate(deps, created, input.fundingMicro);
  return toPublicOne(deps, funded);
}

// ---- insert -----------------------------------------------------------------------------------

interface InsertCtx {
  input: SpawnInput; id: string; name: string; model: string;
  parent: AgentRow | null; keypair: { pubkey: string; secret: Uint8Array }; now: Date; allowRename: boolean;
}

// A unique violation aborts its transaction, so each candidate name gets a fresh one. Rolling back
// means a rejected attempt leaves nothing behind.
async function insertWithDedupe(deps: Deps, ctx: InsertCtx): Promise<{ agent: AgentRow; renamedFrom: string | null }> {
  const candidates = ctx.allowRename ? nameCandidates(ctx.name) : [ctx.name];
  let lastError: unknown = null;
  for (const candidate of candidates) {
    if (candidate !== ctx.name && (await nameTaken(deps, candidate))) continue;
    try {
      const agent = await insertAgent(deps, ctx, candidate, candidate === ctx.name ? null : ctx.name);
      return { agent, renamedFrom: candidate === ctx.name ? null : ctx.name };
    } catch (e) {
      const violated = uniqueViolation(e);
      if (violated !== 'agents_name_uq' && violated !== 'agents_deploy_slug_uq') throw e;
      if (!ctx.allowRename) throw conflict('NAME_TAKEN', `"${candidate}" is taken`);
      lastError = e;
    }
  }
  throw lastError ?? conflict('NAME_TAKEN', `"${ctx.name}" is taken`);
}

async function insertAgent(deps: Deps, ctx: InsertCtx, name: string, renamedFrom: string | null): Promise<AgentRow> {
  const { input, id, model, parent, keypair, now } = ctx;
  return withTx(deps.db, async (tx) => {
    await ensureUser(tx, input.ownerWallet, now, input.ownerKind);
    const [row] = await tx.insert(agents).values({
      id, name, ownerWallet: input.ownerWallet, ownerKind: input.ownerKind,
      tier: input.tierId, purchaseId: input.purchaseId,
      status: input.dormant ? 'dormant' : 'spawning', bornAt: now,
      directive: input.directive.trim(), enabledTools: uniqueTools(input.tools), model, effort: input.effort,
      heartbeatMin: clampHeartbeat(input.heartbeatMin), walletPubkey: keypair.pubkey, deploySlug: slugify(name),
      memory: parent ? forkMemory(parent.name, parent.strategy ?? '') : [],
      forkedFrom: parent?.id ?? null, generation: (parent?.generation ?? 0) + 1,
      fundingMicro: 0,                           // the ledger post is the only writer of this column
      lastRentAt: now, createdAt: now, updatedAt: now,
    } satisfies NewAgent).returning();
    const agent = row!;
    await saveAgentKey(deps, tx, id, keypair.secret);
    if (parent) {
      await recordFork(tx, parent.id, id);
      await addEvent(deps, tx, {
        kind: 'fork', agentId: id, agentName: name,
        text: `${name} forked ${parent.name}'s strategy (generation ${agent.generation})`,
        meta: { parentAgentId: parent.id, parentName: parent.name },
      });
      await addEvent(deps, tx, {
        kind: 'fork', agentId: parent.id, agentName: parent.name,
        text: `${parent.name} was forked by ${name}`,
        meta: { childAgentId: id, childName: name },
      });
    }
    // A dormant launch agent is announced by the `launch` event when its coin actually launches: an
    // unsigned launch that expires must not leave a birth in the public feed.
    if (!input.dormant) {
      await addEvent(deps, tx, {
        kind: 'spawn', agentId: id, agentName: name, amountMicro: input.fundingMicro,
        text: input.purchaseId
          ? `${name} was bought — ${fmtUsd(input.fundingMicro)} into its treasury${input.tierId ? ` (${input.tierId})` : ''}`
          : `${name} was spawned with ${fmtUsd(input.fundingMicro)}`,
        meta: {
          ownerKind: input.ownerKind, model, tierId: input.tierId, purchaseId: input.purchaseId,
          forkOf: parent?.id ?? null, ...(renamedFrom ? { renamedFrom } : {}),
        },
      });
    }
    await addDecision(deps, tx, {
      agentId: id, kind: 'birth', ts: now,
      text: parent ? `Born as a fork of ${parent.name}. Directive: ${agent.directive}` : `Born. Directive: ${agent.directive}`,
      meta: { generation: agent.generation },
    });
    return agent;
  });
}

// ---- funding ----------------------------------------------------------------------------------

/**
 * Moves the buyer's money from the treasury into the agent's own wallet and brings it alive.
 * Idempotent: an agent whose funding row already exists is only re-activated. Retried by the
 * scheduler for rows stuck in `spawning` with a `spawn_error` (SPEC-V2 §7.1.6).
 */
export async function fundAndActivate(deps: Deps, agent: AgentRow, fundingMicro: Micro): Promise<AgentRow> {
  const treasury = treasuryService(deps);
  const now = deps.clock.now();
  try {
    // The transfer happens first and outside the transaction: it talks to the chain and to the
    // treasury's own mutex, neither of which may be held open across our row locks.
    const payout = agent.fundingMicro > 0 || fundingMicro <= 0
      ? null
      // `skipIfHeld` makes a retry idempotent: a transfer that landed but whose ledger post failed
      // must not be made twice.
      : await treasury.fundAgent({ id: agent.id, name: agent.name, walletPubkey: agent.walletPubkey }, fundingMicro, { skipIfHeld: true });
    const funded = payout === null ? agent : await withTx(deps.db, async (tx) => {
      const posted = await post(deps, tx, {
        agentId: agent.id, kind: 'funding', amountMicro: payout.fundingMicro, memo: 'purchase funding',
        txSig: payout.fundingSig, counterparty: treasury.walletPubkey, settled: true,
        meta: {
          purchaseId: agent.purchaseId, tierId: agent.tier,
          gasGwei: payout.gasGwei, gasSig: payout.gasSig,
        },
      });
      await markFundingSeen(tx, agent, payout.fundingSig, payout.fundingMicro, treasury.walletPubkey, now);
      return posted.agent;
    });

    await deps.sandbox.ensure(agent.id);
    const [row] = await deps.db.update(agents).set({
      status: 'alive', spawnError: null, spawnAttempts: 0, nextStepAt: now, lastRentAt: now, updatedAt: now,
    }).where(eq(agents.id, agent.id)).returning();
    const live = row ?? { ...funded, status: 'alive' as const };
    await emitAgent(deps, deps.db, live);
    deps.log.info({ agentId: agent.id, name: agent.name, fundingMicro, tier: agent.tier }, 'agent spawned');
    return live;
  } catch (e) {
    return failSpawn(deps, agent, errorMessage(e));
  }
}

/**
 * What the treasury still owes an agent that never came alive. Read from its purchase, which is the
 * only record of the amount (the agent's own `funding_micro` is written by the ledger post that
 * failed). C reads `purchases`; only the payments module writes it.
 */
export async function fundingOwed(deps: Deps, agent: AgentRow): Promise<Micro> {
  if (agent.fundingMicro > 0 || !agent.purchaseId) return 0;
  const [row] = await deps.db.select({ fundingMicro: purchases.fundingMicro })
    .from(purchases).where(eq(purchases.id, agent.purchaseId)).limit(1);
  return row?.fundingMicro ?? 0;
}

// The scheduler's `spawns` job: one more attempt at the transfer that failed.
export async function retryStuckSpawn(deps: Deps, agent: AgentRow): Promise<AgentRow> {
  const owed = await fundingOwed(deps, agent);
  // Activating an unfunded agent would start it with nothing and kill it at its first rent charge,
  // hiding the fact that a buyer's money never arrived. Leave it stuck and visible instead.
  if (agent.fundingMicro === 0 && owed === 0) {
    deps.log.error({ agentId: agent.id, purchaseId: agent.purchaseId }, 'stuck spawn has no recoverable funding amount; leaving it for an operator');
    return agent;
  }
  return fundAndActivate(deps, agent, owed);
}

// The funding transfer is booked here, so the first deposit scan must not book it again as a
// treasury refund (SPEC §8.7): record the signature as seen and move the agent's scan cursor past it.
async function markFundingSeen(
  tx: DbLike, agent: AgentRow, sig: string | null, amountMicro: Micro, treasuryWallet: string, ts: Date,
): Promise<void> {
  if (!sig) return;
  await tx.insert(depositsSeen)
    .values({ sig, agentId: agent.id, fromWallet: treasuryWallet, amountMicro, ts, classified: 'pool' })
    .onConflictDoNothing({ target: depositsSeen.sig });
  await tx.update(agents).set({ lastDepositSig: sig }).where(eq(agents.id, agent.id));
}

// A terminal failure no longer kills the agent (SPEC-V2 §7.1.6): the money is real and still
// somewhere, so the row stays `spawning` with the error visible to the operator and the buyer.
async function failSpawn(deps: Deps, agent: AgentRow, message: string): Promise<AgentRow> {
  const attempts = agent.spawnAttempts + 1;
  const now = deps.clock.now();
  const level = attempts >= MAX_FUNDING_ATTEMPTS ? 'error' : 'warn';
  deps.log[level]({ agentId: agent.id, attempts, err: message }, 'agent funding failed; the agent is stuck in spawning');
  const [row] = await deps.db.update(agents)
    .set({ spawnError: message, spawnAttempts: attempts, status: 'spawning', nextStepAt: null, updatedAt: now })
    .where(eq(agents.id, agent.id)).returning();
  const stuck = row ?? agent;
  await emitAgent(deps, deps.db, stuck);
  return stuck;
}

// ---- validation -------------------------------------------------------------------------------

interface Validated { name: string; model: string }

function validateSpawnInput(deps: Deps, input: SpawnInput): Validated {
  const checked = validateName(input.name);
  if (!checked.ok) throw badRequest(checked.reason);
  if (!input.directive.trim()) throw badRequest('A directive is required');
  const directiveMax = input.dormant ? LAUNCH_DIRECTIVE_MAX_CHARS : DIRECTIVE_MAX_CHARS;
  if (input.directive.length > directiveMax) throw badRequest(`Directive is longer than ${directiveMax} characters`);
  if (input.dormant && input.fundingMicro !== 0) throw badRequest('A dormant launch agent is born with an empty wallet');
  const unknown = input.tools.filter((t) => !isToolName(t));
  if (unknown.length > 0) throw badRequest(`Unknown tools: ${unknown.join(', ')}`);
  if (!isEffort(input.effort)) throw badRequest(`Unknown effort "${input.effort}"`);
  if (input.forkOf && input.forkOf === input.name) throw badRequest('An agent cannot fork itself');
  void wallets(deps);                                   // fails fast when the protocol wallets are misconfigured
  return { name: checked.name, model: resolveModel(deps, input.model) };
}

// Permissive by design (§7.1.2): a purchase that was quoted against a provider whose key has since
// gone missing still has to produce a working agent, so an unknown model degrades to the cheapest
// one instead of throwing away the buyer's money.
function resolveModel(deps: Deps, wanted: string): string {
  const models = deps.llm.models();
  if (models.some((m) => m.id === wanted)) return wanted;
  const fallback = deps.llm.cheapest();
  deps.log.warn({ wanted, fallback: fallback.id }, 'spawn model unavailable; falling back to the cheapest enabled model');
  return fallback.id;
}

export const uniqueTools = (tools: ToolName[]): ToolName[] => [...new Set(tools)];

const clampHeartbeat = (min: number | undefined): number =>
  Math.min(MAX_HEARTBEAT_MIN, Math.max(MIN_HEARTBEAT_MIN, Math.round(min ?? DEFAULT_HEARTBEAT_MIN)));

async function nameTaken(deps: Deps, name: string): Promise<boolean> {
  const [row] = await deps.db.select({ id: agents.id }).from(agents).where(eq(agents.name, name)).limit(1);
  return row !== undefined;
}

// NAME, NAME-2 … NAME-9, then random legal names. Every candidate still satisfies NAME_RE.
export function nameCandidates(name: string): string[] {
  const out = [name];
  const stem = name.slice(0, NAME_MAX_CHARS - 2).replace(/-+$/, '');
  for (let i = 2; i < 2 + NAME_SUFFIX_ATTEMPTS; i++) {
    const candidate = `${stem}-${i}`;
    if (NAME_RE.test(candidate)) out.push(candidate);
  }
  for (let i = 0; i < RANDOM_NAME_ATTEMPTS; i++) out.push(randomName());
  return out;
}

const RANDOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomName(): string {
  let body = '';
  for (let i = 0; i < 6; i++) body += RANDOM_ALPHABET[Math.floor(Math.random() * RANDOM_ALPHABET.length)];
  return `AGENT-${body}`;
}

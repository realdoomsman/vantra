// The purchase lifecycle that a human drives: create, read, cancel, attach a wallet payment, simulate
// a payment locally, and top an existing agent up (SPEC-V2 §5.2, §5.9, §5.10).
//
// Money never moves here — the poller receives it (poller.ts) and fulfilment spends it (fulfil.ts).
// Nothing in this file ever returns, logs or re-reads a deposit secret or a claim code.
import { eq } from 'drizzle-orm';
import {
  DIRECTIVE_MAX_CHARS, MIN_PROJECTED_LIFE_DAYS, MIN_TOPUP_MICRO, PURCHASE_TTL_HOURS, TIERS,
  claimOwnerId, fmtUsd, isPace, isToolName, tierById, tierForMicro, validateName,
  type Micro, type NameAvailableResponse, type Pace, type PurchasePath, type PurchasePublic, type ToolName,
} from '@vantra/shared';
import { encryptSecret } from '../chain/keys.js';
import type { CreatePurchaseInput } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import { agents, type NewPurchase, type PurchaseRow } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound, unauthorized, uniqueViolation } from '../lib/errors.js';
import { newPurchaseId } from '../lib/ids.js';
import { generateClaimCode, hashClaimCode } from './claim.js';
import type { PaymentsDeps } from './deps.js';
import { quotePurchase, tierOfRow } from './quote.js';
import { insertPurchase, loadPurchase, nameReserved, updatePurchase } from './repo.js';

const HOUR_MS = 3_600_000;

export interface CreatedPurchase { purchase: PurchasePublic; claimCode: string | null }

// ---- reads -----------------------------------------------------------------

/**
 * The public view. Every number the buyer sees comes from the row once the money has landed, and from
 * the checkout quote before that, so the Pending page can say "received $4.00 of $10.00".
 */
export function toPublic(deps: PaymentsDeps, row: PurchaseRow): PurchasePublic {
  const received = row.amountMicro > 0;
  const quote = quotePurchase(deps, {
    amountMicro: received ? row.amountMicro : row.quotedMicro,
    pace: row.pace,
    tier: tierOfRow(row),
    feeBps: row.feeBps,
    ...(row.model ? { modelId: row.model } : {}),
    ...(row.heartbeatMin ? { heartbeatMin: row.heartbeatMin } : {}),
  });
  return {
    id: row.id,
    kind: row.kind,
    path: row.path,
    status: row.status,
    // Nulled the moment the address is emptied, so a swept or expired purchase stops advertising it.
    depositPubkey: row.depositSecretEnc ? row.depositPubkey : null,
    usdcMint: deps.chain.usdcMint,
    cluster: deps.chain.cluster,
    chainMode: deps.chain.mode,
    quotedMicro: row.quotedMicro,
    receivedMicro: row.amountMicro,
    feeMicro: received ? row.feeMicro : quote.feeMicro,
    fundingMicro: received ? row.fundingMicro : quote.fundingMicro,
    feeBps: row.feeBps,
    quotedTierId: row.quotedTier,
    tierId: row.tier,
    agentName: row.agentName,
    agentId: row.agentId,
    topupAgentId: row.topupAgentId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    spawnError: row.spawnError,
    quote,
    ethGweiReceived: row.ethGwei,
    ethValueMicro: row.ethValueMicro,
  };
}

export async function getPurchase(deps: PaymentsDeps, id: string): Promise<PurchasePublic | null> {
  const row = await loadPurchase(deps.db, id);
  return row ? toPublic(deps, row) : null;
}

/** The owner id a purchase belongs to: the buyer's wallet, or the claim identity it mints. */
export const ownerIdOfPurchase = (row: PurchaseRow): string => row.ownerId ?? claimOwnerId(row.id);

export async function nameAvailable(deps: PaymentsDeps, raw: string): Promise<NameAvailableResponse> {
  const check = validateName(raw);
  if (!check.ok) return { name: raw.trim().toUpperCase(), available: false, reason: check.reason };
  const reason = await nameUnavailableReason(deps.db, check.name);
  return { name: check.name, available: reason === null, reason };
}

async function nameUnavailableReason(db: DbLike, name: string): Promise<string | null> {
  const [taken] = await db.select({ id: agents.id }).from(agents).where(eq(agents.name, name)).limit(1);
  if (taken) return `"${name}" is taken`;
  if (await nameReserved(db, name)) return `"${name}" is reserved by a purchase that has not finished yet`;
  return null;
}

// ---- create ----------------------------------------------------------------

export async function createPurchase(deps: PaymentsDeps, input: CreatePurchaseInput): Promise<CreatedPurchase> {
  const { minPurchaseMicro, maxPurchaseMicro } = deps.config.economy;
  const amountMicro = assertAmount(input.amountMicro, minPurchaseMicro, maxPurchaseMicro);

  const named = validateName(input.name);
  if (!named.ok) throw badRequest(named.reason);
  const unavailable = await nameUnavailableReason(deps.db, named.name);
  if (unavailable) throw conflict('NAME_TAKEN', unavailable);

  const directive = (input.directive ?? '').trim();
  if (directive === '') throw badRequest('A directive is required: tell the agent what it is for');
  if (directive.length > DIRECTIVE_MAX_CHARS) throw badRequest(`Directive must be ${DIRECTIVE_MAX_CHARS} characters or fewer`);

  const pace = assertPace(input.pace);
  const tier = tierForMicro(amountMicro);
  const tools = assertTools(input.tools, tier.id);

  const quote = quotePurchase(deps, { amountMicro, pace, tier });
  // The minimum-life gate judges the tier's own pace, not HEARTBEAT_OVERRIDE_MIN. The override is a
  // development knob that deliberately burns an agent down in minutes so a local tester can watch it
  // think; gating on it would refuse every purchase on the local runnable path. It cannot be set in
  // production (config.ts refuses to boot), and the quote the buyer is shown still reflects it.
  const gate = deps.config.economy.heartbeatOverrideMin === null
    ? quote
    : quotePurchase(deps, { amountMicro, pace, tier, ignoreOverride: true });
  if (gate.runwayDays !== null && gate.runwayDays < MIN_PROJECTED_LIFE_DAYS) {
    throw badRequest(
      `${fmtUsd(amountMicro)} only buys ${gate.runwayDays} days of life at ${tier.label} rates; `
      + `the minimum is ${MIN_PROJECTED_LIFE_DAYS} days. Send more, or choose a slower pace.`,
      'BELOW_MINIMUM',
    );
  }

  if (input.forkOf) {
    const [parent] = await deps.db.select({ id: agents.id }).from(agents).where(eq(agents.id, input.forkOf)).limit(1);
    if (!parent) throw notFound('Agent to fork');
  }

  const path: PurchasePath = input.path ?? 'deposit';
  if (path === 'wallet' && !input.ownerWallet) throw unauthorized('Connect a wallet to pay from it, or use the deposit path');

  const id = newPurchaseId();
  const claim = path === 'deposit' ? generateClaimCode() : null;
  const now = deps.clock.now();
  const deposit = mintDepositAddress(deps);

  const row = await insertReserving(deps, named.name, {
    id,
    kind: 'spawn',
    path,
    status: 'pending',
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlHours(deps) * HOUR_MS),
    depositPubkey: deposit.pubkey,
    depositSecretEnc: deposit.enc,
    depositIv: deposit.iv,
    depositTag: deposit.tag,
    claimCodeHash: claim ? hashClaimCode(claim.normalized, deps.config.sessionSecret) : null,
    ownerWallet: path === 'wallet' ? input.ownerWallet! : null,
    // Known from the start on both paths: the claim identity is derived from the purchase id, so the
    // value fulfilment would write is already the value written here.
    ownerId: path === 'wallet' ? input.ownerWallet! : claimOwnerId(id),
    quotedMicro: amountMicro,
    feeBps: quote.feeBps,
    quotedTier: tier.id,
    pace,
    agentName: named.name,
    directive,
    tools,
    forkOf: input.forkOf ?? null,
  });

  deps.log.info({ purchaseId: id, quotedMicro: amountMicro, tier: tier.id, path }, 'purchase created');
  return { purchase: toPublic(deps, row), claimCode: claim?.code ?? null };
}

/**
 * The name check above is a read-then-insert that two simultaneous buyers walk straight through;
 * `purchases_name_reserved_uq` is what actually settles it, so the violation becomes the 409 the
 * caller was already expecting rather than a 500.
 */
async function insertReserving(deps: PaymentsDeps, name: string, values: NewPurchase): Promise<PurchaseRow> {
  try {
    return await insertPurchase(deps.db, values);
  } catch (e) {
    const constraint = uniqueViolation(e);
    if (constraint === null) throw e;
    if (constraint === 'purchases_name_reserved_uq') throw conflict('NAME_TAKEN', `"${name}" is taken`);
    // A duplicate deposit address or claim-code hash is a 2^100 coincidence; say so rather than 500.
    throw conflict('CONFLICT', 'That purchase could not be created; please try again');
  }
}

/** A fresh one-time keypair. The secret is encrypted before it ever reaches a variable we keep. */
function mintDepositAddress(deps: PaymentsDeps): { pubkey: string; enc: Buffer; iv: Buffer; tag: Buffer } {
  const keypair = deps.chain.newKeypair();
  const { enc, iv, tag } = encryptSecret(keypair.secret, deps.config.keyEncryptionKey);
  keypair.secret.fill(0);
  return { pubkey: keypair.pubkey, enc, iv, tag };
}

// ---- top-ups ---------------------------------------------------------------

export async function topUp(
  deps: PaymentsDeps,
  agentId: string,
  ownerId: string,
  amountMicro: Micro,
  path: PurchasePath,
): Promise<PurchasePublic> {
  const [agent] = await deps.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) throw notFound('Agent');
  if (agent.ownerWallet !== ownerId) throw forbidden('Only the owner can top this agent up');
  if (agent.status === 'dead') throw conflict('NOT_ELIGIBLE', `${agent.name} is dead; revive it before topping it up`);

  const amount = assertAmount(amountMicro, MIN_TOPUP_MICRO, deps.config.economy.maxPurchaseMicro);
  const id = newPurchaseId();
  const now = deps.clock.now();
  const deposit = mintDepositAddress(deps);
  const tier = tierById(agent.tier ?? '') ?? tierForMicro(amount);

  const row = await insertPurchase(deps.db, {
    id,
    kind: 'topup',
    path,
    status: 'pending',
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlHours(deps) * HOUR_MS),
    depositPubkey: deposit.pubkey,
    depositSecretEnc: deposit.enc,
    depositIv: deposit.iv,
    depositTag: deposit.tag,
    claimCodeHash: null,                        // the caller already has a session
    ownerWallet: path === 'wallet' ? ownerId : null,
    ownerId,
    quotedMicro: amount,
    feeBps: deps.config.economy.founderFeeBps,
    quotedTier: tier.id,
    pace: 'steady',
    topupAgentId: agentId,
  });

  deps.log.info({ purchaseId: id, agentId, quotedMicro: amount }, 'top-up created');
  return toPublic(deps, row);
}

// ---- cancel ----------------------------------------------------------------

/**
 * Cancelling is just expiring early: the poller's expiry path then refunds anything above dust to the
 * sender and sweeps the rest, so a cancel can never strand money at a deposit address.
 */
export async function cancelPurchase(deps: PaymentsDeps, id: string, ownerId: string): Promise<PurchaseRow> {
  const row = await loadPurchase(deps.db, id);
  if (!row) throw notFound('Purchase');
  if (ownerIdOfPurchase(row) !== ownerId) throw forbidden('Only the buyer can cancel this purchase');
  if (row.status !== 'pending') throw conflict('CONFLICT', `This purchase is ${row.status} and can no longer be cancelled`);
  return updatePurchase(deps.db, id, { expiresAt: deps.clock.now() });
}

// ---- validation helpers ----------------------------------------------------

function assertAmount(amountMicro: unknown, minMicro: Micro, maxMicro: Micro): Micro {
  if (typeof amountMicro !== 'number' || !Number.isSafeInteger(amountMicro)) {
    throw badRequest('amountMicro must be an integer number of micro-dollars');
  }
  if (amountMicro < minMicro) throw badRequest(`The minimum is ${fmtUsd(minMicro)}`, 'BELOW_MINIMUM');
  if (amountMicro > maxMicro) throw badRequest(`The maximum is ${fmtUsd(maxMicro)}`, 'ABOVE_MAXIMUM');
  return amountMicro;
}

function assertPace(pace: string | undefined): Pace {
  if (pace === undefined) return 'steady';
  if (!isPace(pace)) throw badRequest(`Unknown pace "${pace}"`);
  return pace;
}

/** Tools default to everything the tier unlocks; anything above the tier names the tier that unlocks it. */
function assertTools(tools: ToolName[] | undefined, tierId: string): ToolName[] {
  const tier = tierById(tierId)!;
  if (!tools) return [...tier.enabledTools];
  const allowed = new Set<string>(tier.enabledTools);
  const chosen: ToolName[] = [];
  for (const tool of tools) {
    if (!isToolName(tool)) throw badRequest(`Unknown tool "${String(tool)}"`);
    if (!allowed.has(tool)) {
      const unlocks = TIERS.find((t) => t.enabledTools.includes(tool));
      throw badRequest(
        unlocks
          ? `"${tool}" is not available at ${tier.label}; it unlocks at ${unlocks.label} (${fmtUsd(unlocks.minMicro)})`
          : `"${tool}" is not available at ${tier.label}`,
      );
    }
    if (!chosen.includes(tool)) chosen.push(tool);
  }
  if (chosen.length === 0) throw badRequest('An agent needs at least one tool');
  return chosen;
}

const ttlHours = (deps: PaymentsDeps): number => deps.config.economy.purchaseTtlHours || PURCHASE_TTL_HOURS;

// Fulfilment (SPEC-V2 §5.4): sweep the deposit address, book the money on the treasury, resolve the
// owner identity and bring the agent into existence — or credit an existing one for a top-up.
//
// Every step is idempotent, because this runs again on the next poller tick after any failure:
//   · the sweep is guarded by the encrypted secret, which is NULLed the moment the address is emptied;
//   · the treasury booking is guarded by a `pool_txs` row carrying the purchase id;
//   · the spawn is guarded by `status='received' and agent_id is null`.
// The money is never at risk in between: it is either still in the deposit address (secret encrypted
// at rest) or already in the treasury.
import { and, desc, eq } from 'drizzle-orm';
import { claimOwnerId, fmtUsd, isClaimOwnerId, ownerKindOf, tierById } from '@vantra/shared';
import { decryptSecret, wipeSecret } from '../chain/keys.js';
import { getProtocolWallets } from '../chain/wallets.js';
import { treasuryService } from '../economy/treasury.js';
import { addEvent } from '../economy/events.js';
import type { SweepOut } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import { ledger, users, type PurchaseRow } from '../db/schema.js';
import { errorMessage } from '../lib/errors.js';
import type { PaymentsDeps } from './deps.js';
import { loadPurchase, transition, updatePurchase } from './repo.js';

export const MAX_FULFIL_ATTEMPTS = 5;

// One in-process gate per purchase: the poller, a simulate-pay and an attach can all land on the same
// row at once, and the chain half of this cannot sit inside a database transaction.
const inFlight = new Map<string, Promise<PurchaseRow | null>>();

export async function fulfil(deps: PaymentsDeps, purchaseId: string): Promise<PurchaseRow | null> {
  const existing = inFlight.get(purchaseId);
  if (existing) return existing;
  const run = fulfilOnce(deps, purchaseId).finally(() => inFlight.delete(purchaseId));
  inFlight.set(purchaseId, run);
  return run;
}

async function fulfilOnce(deps: PaymentsDeps, purchaseId: string): Promise<PurchaseRow | null> {
  let row = await loadPurchase(deps.db, purchaseId);
  if (!row || row.status !== 'received' || row.agentId) return row;
  if (row.spawnAttempts >= MAX_FULFIL_ATTEMPTS) return row;

  try {
    row = await sweepAndBook(deps, row);
    row = await deliver(deps, row);
    return row;
  } catch (e) {
    const message = errorMessage(e);
    const attempts = row.spawnAttempts + 1;
    deps.log.error({ purchaseId, attempts, err: e }, 'purchase fulfilment failed');
    return updatePurchase(deps.db, purchaseId, { spawnAttempts: attempts, spawnError: message });
  }
}

// ---- step 1–3: sweep the deposit address and book it on the treasury -------

async function sweepAndBook(deps: PaymentsDeps, row: PurchaseRow): Promise<PurchaseRow> {
  const treasury = treasuryService(deps);
  const wallets = getProtocolWallets(deps.config);
  if (!row.depositSecretEnc || !row.depositIv || !row.depositTag) return row;   // already swept

  const secret = decryptSecret({ enc: row.depositSecretEnc, iv: row.depositIv, tag: row.depositTag }, deps.config.keyEncryptionKey);
  let sweepSig: string | null = null;
  let solSweepSig: string | null = null;
  let feeShortfallSig: string | null = null;
  // The USDC that actually reaches the treasury: the gross minus whatever the founder fee could take
  // out of the deposit's own USDC.
  const feeFromDeposit = Math.min(row.feeMicro, row.usdcMicro);
  const toTreasury = row.usdcMicro - feeFromDeposit;
  const feeShortfall = row.feeMicro - feeFromDeposit;

  try {
    if (row.usdcMicro > 0) {
      const outs: SweepOut[] = [];
      if (feeFromDeposit > 0) outs.push({ to: wallets.founderFee, amount: feeFromDeposit });
      if (toTreasury > 0) outs.push({ to: wallets.treasury.pubkey, amount: toTreasury });
      if (outs.length > 0) {
        sweepSig = (await deps.chain.sweepUsdc(secret, wallets.treasury.secret, outs, `VANTRA ${row.id}`)).sig;
      }
    }
    if (row.ethGwei > 0) {
      solSweepSig = (await deps.chain.sweepEth(secret, wallets.treasury.secret, wallets.treasury.pubkey, row.ethGwei)).sig;
    }
    // An ETH-paid purchase leaves the founder fee unfunded in USDC: settle the remainder out of the
    // treasury, which is where the ETH just landed.
    if (feeShortfall > 0) {
      feeShortfallSig = (await deps.chain.transferUsdc(wallets.treasury.secret, wallets.founderFee, feeShortfall, `VANTRA fee ${row.id}`)).sig;
    }
  } finally {
    wipeSecret(secret);
  }

  await treasury.recordPurchase({
    purchaseId: row.id,
    grossMicro: row.amountMicro,
    feeMicro: row.feeMicro,
    usdcInflowMicro: Math.max(0, toTreasury - feeShortfall),
    ethGweiInflow: row.ethGwei,
    txSig: sweepSig ?? solSweepSig,
    kind: row.kind === 'topup' ? 'topup' : 'purchase',
    agentId: row.topupAgentId,
  });

  deps.log.info(
    { purchaseId: row.id, status: row.status, grossMicro: row.amountMicro, tier: row.tier },
    'purchase swept to the treasury',
  );
  return updatePurchase(deps.db, row.id, {
    depositSecretEnc: null, depositIv: null, depositTag: null,
    sweepSig,
    meta: { ...row.meta, solSweepSig, feeShortfallSig, feeShortfallMicro: feeShortfall },
  });
}

// ---- step 4–7: owner identity, spawn or credit, then say so publicly -------

async function deliver(deps: PaymentsDeps, row: PurchaseRow): Promise<PurchaseRow> {
  const services = deps.services;
  if (!services) throw new Error('services are not wired yet');
  const ownerId = row.kind === 'topup' ? (row.ownerId ?? '') : (row.path === 'wallet' ? (row.ownerWallet ?? '') : claimOwnerId(row.id));
  if (!ownerId) throw new Error(`purchase ${row.id} has no owner to deliver to`);
  await ensureOwner(deps.db, ownerId, row.id, deps.clock.now());

  if (row.kind === 'topup') {
    const agentId = row.topupAgentId!;
    const agent = await services.creditTopUp(agentId, row.id, row.fundingMicro);
    const done = await transition(deps.db, row.id, ['received'], {
      status: 'spawned', ownerId, agentId,
      fundingSig: await fundingSigOf(deps.db, agentId, 'recapitalize'),
      spawnError: null,
    });
    await addEvent(deps, deps.db, {
      kind: 'topup', agentId, agentName: agent.name, amountMicro: row.fundingMicro,
      text: `${agent.name} was topped up with ${fmtUsd(row.fundingMicro)}`,
      meta: { purchaseId: row.id, grossMicro: row.amountMicro, feeMicro: row.feeMicro },
    });
    return done ?? row;
  }

  const tier = tierById(row.tier ?? '');
  const agent = await services.spawn({
    ownerWallet: ownerId,
    ownerKind: ownerKindOf(ownerId),
    name: row.agentName!,
    directive: row.directive ?? '',
    tools: row.tools ?? [],
    model: row.model ?? '',
    effort: row.effort ?? 'medium',
    heartbeatMin: row.heartbeatMin ?? 60,
    fundingMicro: row.fundingMicro,
    tierId: tier?.id ?? null,
    purchaseId: row.id,
    ...(row.forkOf ? { forkOf: row.forkOf } : {}),
  });

  const done = await transition(deps.db, row.id, ['received'], {
    status: 'spawned', ownerId, agentId: agent.id,
    fundingSig: await fundingSigOf(deps.db, agent.id, 'funding'),
    spawnError: null,
  });
  await addEvent(deps, deps.db, {
    kind: 'purchase', agentId: agent.id, agentName: agent.name, amountMicro: row.amountMicro,
    text: `${agent.name} was bought for ${fmtUsd(row.amountMicro)} — ${fmtUsd(row.fundingMicro)} into its treasury`
      + `${tier ? ` (${tier.label})` : ''}`,
    meta: { purchaseId: row.id, tierId: tier?.id ?? null, feeMicro: row.feeMicro },
  });
  deps.log.info({ purchaseId: row.id, status: 'spawned', grossMicro: row.amountMicro, tier: row.tier }, 'purchase fulfilled');
  return done ?? row;
}

/** The owner row every session and every FK hangs off. Claim owners carry the purchase that minted them. */
async function ensureOwner(db: DbLike, ownerId: string, purchaseId: string, now: Date): Promise<void> {
  const claim = isClaimOwnerId(ownerId);
  await db.insert(users).values({
    wallet: ownerId,
    kind: claim ? 'claim' : 'wallet',
    purchaseId: claim ? purchaseId : null,
    createdAt: now,
    lastLoginAt: now,
  }).onConflictDoNothing({ target: users.wallet });
}

/** Best effort: the on-chain signature the ledger recorded for this agent's funding. */
async function fundingSigOf(db: DbLike, agentId: string, kind: 'funding' | 'recapitalize'): Promise<string | null> {
  const [row] = await db.select({ txSig: ledger.txSig }).from(ledger)
    .where(and(eq(ledger.agentId, agentId), eq(ledger.kind, kind)))
    .orderBy(desc(ledger.id)).limit(1);
  return row?.txSig ?? null;
}

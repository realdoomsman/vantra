// Custodial wallets for Google owners (SPEC-V2 §6.2 extension). A Google login has no wallet of its
// own, so the server holds one for it: a secp256k1 key generated on first login, whose 32-byte secret
// is encrypted at rest in `user_keys` (same AES-256-GCM custody as agent keys) and NEVER returned by
// any API. The owner deposits USDC to the wallet's EIP-55 address and withdraws it to any Ethereum
// address; the treasury pre-funds the gas for that withdrawal, so the custodial wallet itself never
// has to hold ETH.
import { eq } from 'drizzle-orm';
import { toBytes } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { fmtUsd, isGoogleOwnerId, type CustodialWallet, type CustodialWithdrawResponse } from '@vantra/shared';
import { wipeSecret } from '../chain/keys.js';
import { storeUserKey, withUserSecret } from '../chain/keystore.js';
import { getProtocolWallets } from '../chain/wallets.js';
import type { CoreDeps } from '../core/interfaces.js';
import { users } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import { isEvmAddress, toChecksum } from '../lib/evm.js';
import { loadUser } from './repo.js';

type Deps = CoreDeps;

// Idempotent: returns the existing custodial address, or generates + persists one on first call. Only a
// Google owner gets one — a wallet owner already has their own key, a claim owner is tied to one agent.
export async function ensureCustodialWallet(deps: Deps, ownerId: string): Promise<string> {
  if (!isGoogleOwnerId(ownerId)) throw badRequest('Only Google accounts have a custodial wallet');
  const existing = await loadUser(deps.db, ownerId);
  if (existing?.custodialPubkey) return existing.custodialPubkey;
  // 32 random bytes from viem's secp256k1 generator; `storeUserKey` derives the EIP-55 address from
  // it and persists only the encrypted secret.
  const secret = toBytes(generatePrivateKey());
  try {
    const pubkey = await storeUserKey(deps.db, deps.config.keyEncryptionKey, ownerId, secret);
    await deps.db.update(users).set({ custodialPubkey: pubkey }).where(eq(users.wallet, ownerId));
    deps.log.info({ ownerId, pubkey }, 'custodial wallet created');
    return pubkey;
  } catch (e) {
    // A racing login/request already inserted the row — fall back to the persisted one.
    const row = await loadUser(deps.db, ownerId);
    if (row?.custodialPubkey) return row.custodialPubkey;
    throw e;
  } finally {
    wipeSecret(secret);
  }
}

// The address to deposit to plus its live on-chain balances.
export async function custodialWallet(deps: Deps, ownerId: string): Promise<CustodialWallet> {
  const pubkey = await ensureCustodialWallet(deps, ownerId);
  const [usdcMicro, ethGwei] = await Promise.all([
    deps.chain.getUsdcBalance(pubkey),
    deps.chain.getEthBalance(pubkey),
  ]);
  return { pubkey, usdcMicro, ethGwei };
}

// Sends `amountMicro` USDC from the custodial wallet to any Ethereum address. The treasury sponsors
// the gas (sweepUsdc tops the wallet up before sweeping), so the custodial wallet needs no ETH of
// its own and the destination needs no prior setup — an ERC-20 transfer credits any address.
export async function withdrawCustodial(deps: Deps, ownerId: string, to: string, amountMicro: number): Promise<CustodialWithdrawResponse> {
  if (!isGoogleOwnerId(ownerId)) throw badRequest('Only Google accounts have a custodial wallet');
  if (!isEvmAddress(to)) throw badRequest('That is not a valid Ethereum address');
  const dest = toChecksum(to);
  if (!Number.isInteger(amountMicro) || amountMicro <= 0) throw badRequest('Amount must be a positive number of micro-USDC');
  const pubkey = await ensureCustodialWallet(deps, ownerId);
  const balance = await deps.chain.getUsdcBalance(pubkey);
  if (amountMicro > balance) throw badRequest(`Balance is only ${fmtUsd(balance)}`);
  const wallets = getProtocolWallets(deps.config);
  const { sig } = await withUserSecret(deps.db, deps.config.keyEncryptionKey, ownerId, (secret) =>
    deps.chain.sweepUsdc(secret, wallets.treasury.secret, [{ to: dest, amount: amountMicro }], 'VANTRA withdraw'));
  deps.log.info({ ownerId, to: dest, amountMicro, sig }, 'custodial withdraw');
  return { sentMicro: amountMicro, txSig: sig };
}

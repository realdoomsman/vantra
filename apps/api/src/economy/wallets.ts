// Custody facade over the chain module: the three protocol wallets and the agent key store.
// Secrets are decrypted inside chain/keystore for the duration of one transfer and never logged.
import type { Micro } from '@vantra/shared';
import { isChainError } from '../chain/errors.js';
import { storeAgentKey, withAgentSecret } from '../chain/keystore.js';
import { getProtocolWallets, type ProtocolWallets, type Signer, type WalletAwareChain } from '../chain/wallets.js';
import type { CoreDeps } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import { ApiError } from '../lib/errors.js';

// `db` is DbLike so a caller holding a transaction can read the agent key on the SAME connection
// (economy/withdraw.ts transfers while it holds the agent row lock).
export type WalletDeps = Pick<CoreDeps, 'config' | 'chain'> & { db: DbLike };
export type { ProtocolWallets, Signer };

// Adapters that carry their own wallets (the memory chain funds its pool at creation) win over the
// config-derived ones so both sides always mean the same keypairs.
export const wallets = (deps: Pick<CoreDeps, 'config' | 'chain'>): ProtocolWallets =>
  (deps.chain as Partial<WalletAwareChain>).wallets ?? getProtocolWallets(deps.config);

export const chainFailure = (e: unknown): ApiError =>
  isChainError(e, 'insufficient_funds')
    ? new ApiError(409, 'NOT_ELIGIBLE', e.message)
    : new ApiError(502, 'CHAIN_ERROR', `Chain transfer failed: ${e instanceof Error ? e.message : String(e)}`);

export async function saveAgentKey(deps: WalletDeps, db: DbLike, agentId: string, secret: Uint8Array): Promise<void> {
  await storeAgentKey(db, deps.config.keyEncryptionKey, agentId, secret);
}

// USDC out of an agent's custodied wallet (withdrawals, settlement sweeps, agent→agent payments).
export async function transferFromAgent(deps: WalletDeps, agentId: string, to: string, amount: Micro, memo: string): Promise<string> {
  try {
    return await withAgentSecret(deps.db, deps.config.keyEncryptionKey, agentId, async (secret) =>
      (await deps.chain.transferUsdc(secret, to, amount, memo)).sig);
  } catch (e) {
    throw chainFailure(e);
  }
}

// USDC out of the protocol-custodied escrow wallet (bounty payouts and refunds).
export async function transferFromEscrow(deps: WalletDeps, to: string, amount: Micro, memo: string): Promise<string> {
  try {
    return (await deps.chain.transferUsdc(wallets(deps).escrow.secret, to, amount, memo)).sig;
  } catch (e) {
    throw chainFailure(e);
  }
}

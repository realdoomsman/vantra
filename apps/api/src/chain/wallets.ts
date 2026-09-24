// The four server-side wallets (SPEC-V2 §1.4): TREASURY (purchase proceeds, agent funding, gas),
// ESCROW (bounty rewards), PROTOCOL FEE (swept metered spend) and FOUNDER FEE (the platform's cut of
// every purchase). Only the first two are signers; the other two are destinations we never sign for.
// In robinhood mode they come from env; in memory mode missing ones are derived deterministically from
// KEY_ENCRYPTION_KEY so addresses stay stable across restarts.
import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { ChainAdapter } from '../core/interfaces.js';
import { ChainError } from './errors.js';
import { loadSecret, pubkeyOfSecret } from './keys.js';

export interface Signer { readonly pubkey: string; readonly secret: Uint8Array }
export interface ProtocolWallets {
  treasury: Signer;
  escrow: Signer;
  protocolFee: string;
  founderFee: string;      // address only; in memory mode a derived one so the fee is still observable
}

// Both adapters carry their protocol wallets so the treasury service and the boot log never re-derive them.
export interface WalletAwareChain extends ChainAdapter { readonly wallets: ProtocolWallets }

const cache = new WeakMap<Config, ProtocolWallets>();

export function getProtocolWallets(config: Config): ProtocolWallets {
  const cached = cache.get(config);
  if (cached) return cached;
  const wallets = config.chain.mode === 'memory' ? memoryWallets(config) : envWallets(config);
  cache.set(config, wallets);
  return wallets;
}

function envWallets(config: Config): ProtocolWallets {
  const { treasuryWalletSecret, escrowWalletSecret, protocolFeeWallet, founderFeeWallet } = config.chain;
  if (!treasuryWalletSecret || !escrowWalletSecret || !protocolFeeWallet || !founderFeeWallet) {
    throw new ChainError(
      'invalid_key',
      'TREASURY_WALLET_SECRET, ESCROW_WALLET_SECRET, PROTOCOL_FEE_WALLET and FOUNDER_FEE_WALLET are required in robinhood mode',
    );
  }
  return {
    treasury: signerFromSecret(loadSecret(treasuryWalletSecret)),
    escrow: signerFromSecret(loadSecret(escrowWalletSecret)),
    protocolFee: protocolFeeWallet,
    founderFee: founderFeeWallet,
  };
}

// sha256 of the role and the KEK is a uniformly distributed 32-byte value, which is exactly what a
// secp256k1 private key is — so a memory-mode deployment keeps stable wallets across restarts
// without ever holding a real key.
function memoryWallets(config: Config): ProtocolWallets {
  const { treasuryWalletSecret, escrowWalletSecret, protocolFeeWallet, founderFeeWallet } = config.chain;
  const derived = (role: string): Signer => {
    const seed = createHash('sha256').update(`vantra:memory:${role}:${config.keyEncryptionKey}`).digest();
    return signerFromSecret(new Uint8Array(seed));
  };
  return {
    treasury: treasuryWalletSecret ? signerFromSecret(loadSecret(treasuryWalletSecret)) : derived('treasury'),
    escrow: escrowWalletSecret ? signerFromSecret(loadSecret(escrowWalletSecret)) : derived('escrow'),
    protocolFee: protocolFeeWallet ?? derived('protocol-fee').pubkey,
    founderFee: founderFeeWallet ?? derived('founder-fee').pubkey,
  };
}

function signerFromSecret(secret: Uint8Array): Signer {
  return { pubkey: pubkeyOfSecret(secret), secret };
}

// Adapters for the ports other modules declare (tools/ports.ts, hosting/service.ts). Tools never write
// ledger rows — they return costMicro and the step loop posts it — so these only move real USDC and
// give hosting the one ledger hook it needs for the seller's compute.
import type { CoreDeps } from '../core/interfaces.js';
import type { LedgerHook, PaymentRefund } from '../hosting/service.js';
import type { EscrowPort, PaymentsPort } from '../tools/ports.js';
import { post } from './ledger.js';
import { transferFromAgent, transferFromEscrow, wallets } from './wallets.js';

type Deps = CoreDeps;

export const paymentsPort = (deps: Deps): PaymentsPort => ({
  transferFromAgent: (agentId, toPubkey, amountMicro, memo) => transferFromAgent(deps, agentId, toPubkey, amountMicro, memo),
});

export function escrowPort(deps: Deps): EscrowPort {
  return {
    get pubkey() {
      return wallets(deps).escrow.pubkey;
    },
    payout: (toPubkey, amountMicro, memo) => transferFromEscrow(deps, toPubkey, amountMicro, memo),
  };
}

// hosting/service.ts charges the seller's compute through this hook (AMENDMENTS B19).
export function hostingLedgerHook(deps: Deps): LedgerHook {
  return async (agentId, kind, amountMicro, memo, meta) => {
    await post(deps, deps.db, { agentId, kind, amountMicro, memo, meta });
  };
}

// Sends a paid-up-front buyer their money back when the seller's handler failed or timed out.
export function hostingRefund(deps: Deps): PaymentRefund {
  return (sellerAgentId, toWallet, amountMicro, memo) => transferFromAgent(deps, sellerAgentId, toWallet, amountMicro, memo);
}

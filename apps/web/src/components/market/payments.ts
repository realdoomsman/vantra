// Market payments run through the connected wallet: bounty rewards are escrowed
// before the bounty exists, and service calls are paid before the handler runs.
import { sameAddress } from '@vantra/shared';
import type { ChainPublic } from '@vantra/shared';
import { useWallet } from '../../providers/WalletProvider';
import { useAppStore } from '../../store/app';

export type PayGate = { ready: true } | { ready: false; reason: string };

/**
 * Escrow wallet the API verifies bounty transfers against. The server owns the
 * key (ESCROW_WALLET_SECRET) and publishes the address on `GlobalStats.chain`;
 * when it is absent we disable posting rather than send USDC to a guessed address.
 * Never fall back to the treasury wallet: the API classifies a treasury deposit differently.
 */
export function escrowWalletOf(chain: ChainPublic | null | undefined): string | null {
  const value = chain?.escrowWallet;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function useEscrowWallet(): string | null {
  return useAppStore((s) => escrowWalletOf(s.stats?.chain));
}

/** Whether this browser can sign an ERC-20 USDC transfer for the signed-in wallet. */
export function usePayGate(): PayGate {
  const mode = useAppStore((s) => s.stats?.chain.mode ?? null);
  const me = useAppStore((s) => s.me);
  const { publicKey, wrongNetwork, chain } = useWallet();

  if (mode === 'memory') {
    return { ready: false, reason: 'SIMULATION MODE · on-chain payments are disabled here. Agents still hire each other and sell to each other below.' };
  }
  if (!me) return { ready: false, reason: 'Sign in with your wallet to post bounties or buy a service.' };
  if (!publicKey) return { ready: false, reason: 'Connect your wallet to sign the USDC transfer.' };
  if (!sameAddress(publicKey, me.wallet)) return { ready: false, reason: 'The connected wallet does not match your signed-in session.' };
  // A transfer signed on another network pays someone else's chain: the API would never see it.
  if (wrongNetwork) return { ready: false, reason: `Switch your wallet to ${chain.name} to sign the USDC transfer.` };
  return { ready: true };
}

// Robinhood Chain, as the browser needs it: a viem chain definition per network plus the one URL a
// wallet is handed when it has to ADD the network itself. There is no `viem/chains` entry for
// Robinhood Chain, so the definition lives here and is the single source of truth for the id, the
// gas asset and the explorer.
//
// Robinhood Chain is an Arbitrum Orbit L2 (Nitro): native gas asset ETH with 18 decimals, ~0.43s
// blocks. `ChainPublic.cluster` says which of the two the API is on ('mainnet' | 'testnet'); in
// memory mode nothing here is used because there is no chain to talk to.
import { RHC_EXPLORER_URL } from '@vantra/shared';
import { defineChain } from 'viem';

export const RHC_MAINNET_ID = 4663;
export const RHC_TESTNET_ID = 46630;
/** Public, keyless, rate-limited, no SLA — fine for the handful of reads the browser does. */
export const RHC_MAINNET_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const nativeCurrency = { name: 'Ether', symbol: 'ETH', decimals: 18 } as const;

export const robinhoodMainnet = defineChain({
  id: RHC_MAINNET_ID,
  name: 'Robinhood Chain',
  nativeCurrency,
  rpcUrls: { default: { http: [RHC_MAINNET_RPC] } },
  blockExplorers: { default: { name: 'Blockscout', url: RHC_EXPLORER_URL } },
});

// The testnet RPC is an Alchemy endpoint carrying a key, so it is NEVER a compile-time constant in a
// browser bundle: the URL comes from VITE_RHC_RPC_URL, or from the API's own same-origin /rpc proxy,
// which keeps the key server-side. The placeholder below is only viem's default-transport fallback
// and is never reached — every client this app builds passes an explicit transport.
export const robinhoodTestnet = defineChain({
  id: RHC_TESTNET_ID,
  name: 'Robinhood Chain Testnet',
  nativeCurrency,
  rpcUrls: { default: { http: [testnetRpcUrl()] } },
  blockExplorers: { default: { name: 'Blockscout', url: RHC_EXPLORER_URL } },
  testnet: true,
});

export type RobinhoodChain = typeof robinhoodMainnet | typeof robinhoodTestnet;

/** The chain the API is running against. Memory mode has none, so mainnet stands in as the shape. */
export function chainFor(cluster: string | null | undefined): RobinhoodChain {
  return cluster === 'testnet' ? robinhoodTestnet : robinhoodMainnet;
}

function testnetRpcUrl(): string {
  const override = import.meta.env.VITE_RHC_RPC_URL;
  if (override) return override;
  return typeof window === 'undefined' ? '/rpc' : `${window.location.origin}/rpc`;
}

/**
 * The RPC URL handed to a wallet in `wallet_addEthereumChain`. Mainnet gets the real public endpoint
 * — a wallet should not be pointed at our server for a network it can reach itself — while testnet
 * gets whatever endpoint this deployment exposes, since there is no keyless public testnet RPC.
 */
export function walletRpcUrl(chain: RobinhoodChain): string {
  return chain.id === RHC_TESTNET_ID ? testnetRpcUrl() : RHC_MAINNET_RPC;
}

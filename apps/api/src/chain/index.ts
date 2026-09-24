// Chain module: the ChainAdapter (memory simulator or real Robinhood Chain), the Pons launchpad port,
// the protocol wallets and key custody, the treasury service and transaction verification.
import type { Config } from '../config.js';
import type { ChainAdapter, Clock, LaunchpadPort } from '../core/interfaces.js';
import type { Logger } from '../lib/log.js';
import { createEvmChain } from './evm.js';
import { createEvmLaunchpad, createMemoryLaunchpad } from './launchpad.js';
import { createMemoryChain } from './memory.js';
import type { WalletAwareChain } from './wallets.js';

// CHAIN_MODE=memory → in-process simulator (funds the treasury float, exposes faucet); robinhood →
// Robinhood Chain mainnet/testnet. SPEC-V2 §5.6, §5.7. The treasury itself is one instance per
// container: economy/treasury.ts builds it from createTreasuryService + createTreasuryStore.
// `clock` only reaches the simulator, which stamps its transactions with it so demo history is dated
// by the fast-forward clock rather than by wall time. The launchpad is built here, beside the adapter,
// because the memory fake settles claims and burns in the memory chain's own balances.
export async function createChain(
  config: Config, log: Logger, opts: { clock?: Clock } = {},
): Promise<{ chain: ChainAdapter; launchpad: LaunchpadPort }> {
  let chain: WalletAwareChain;
  let launchpad: LaunchpadPort;
  if (config.chain.mode === 'memory') {
    const memory = createMemoryChain(config, log, opts);
    chain = memory;
    launchpad = createMemoryLaunchpad(config, memory, log.child({ mod: 'launchpad' }));
  } else {
    chain = createEvmChain(config, log);
    launchpad = createEvmLaunchpad(config, log.child({ mod: 'launchpad' }));
  }
  log.info(
    { mode: chain.mode, cluster: chain.cluster, usdcMint: chain.usdcMint, treasury: chain.wallets.treasury.pubkey },
    'chain ready',
  );
  return { chain, launchpad };
}

export { ChainError, isChainError, type ChainErrorCode } from './errors.js';
export {
  EVM_SCAN_BLOCKS, NATIVE_TOKEN, RPC_ATTEMPTS, createEvmChain, createEvmTransactor, isTransientRpcError,
  publicClientFor, rhcChain, walletClientFor, type EvmTransactor, type RhcPublicClient, type RhcWalletClient,
} from './evm.js';
export {
  SECRET_KEY_BYTES, accountFromSecret, decryptSecret, encryptSecret, loadSecret, pubkeyOfSecret,
  wipeSecret, type EncryptedSecret,
} from './keys.js';
export { loadAgentSecret, storeAgentKey, withAgentSecret } from './keystore.js';
export {
  MEMORY_LAUNCH_FDV_USD, PONS_LAUNCH_FEE_WEI, PONS_MAX_CREATOR_TAX_BPS, WEI_PER_GWEI, createEvmLaunchpad,
  createMemoryLaunchpad, type LaunchCallParams, type LaunchpadPort,
} from './launchpad.js';
export { createMemoryChain, type MemoryChain } from './memory.js';
export { Mutex, withAddressLock } from './mutex.js';
export {
  TREASURY_SYNC_INTERVAL_MS, createTreasuryService,
  type FundAgentOpts, type FundingPayout, type GasTopUp, type RecordPurchaseInput, type TreasuryAgentRef,
  type TreasuryInflowKind, type TreasuryService,
} from './pool.js';
export { TREASURY_ROW_ID, createTreasuryStore, type TreasuryStore, type TreasuryTxInsert } from './poolStore.js';
export {
  extractTokenTransfers, largestUsdcTransfer, resolveInflow, usdcInflowsTo,
  type EvmLog, type ResolvedInflow, type TokenTransfer,
} from './parse.js';
export {
  PONS_FACTORY, PONS_FEE_ESCROW, PONS_LAUNCH_CONFIG_ID, PONS_ROUTER, PONS_TOKEN_SUPPLY, TOKEN_LAUNCHED_TOPIC0,
  ZERO_ADDRESS, ponsBondingCurveAbi, ponsFactoryAbi, ponsFeeEscrowAbi, ponsTokenAbi, ponsUrl,
} from './pons.js';
export { FALLBACK_ETH_PRICE, createEthPriceSource, gweiToMicro, type EthPriceSource } from './price.js';
export { invalidTx, shortAddr, verifyUsdcTransfer, type VerifyUsdcOpts } from './verify.js';
export { getProtocolWallets, type ProtocolWallets, type Signer, type WalletAwareChain } from './wallets.js';

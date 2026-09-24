// The real implementations behind PreflightProbes. Kept out of preflight.ts so the rules stay
// testable without dockerode or a viem client, and so this file is the only place that reaches the
// outside world at boot.
import Docker from 'dockerode';
import { publicClientFor } from '../chain/evm.js';
import { getProtocolWallets } from '../chain/wallets.js';
import type { Config } from '../config.js';
import type { ChainAdapter } from './interfaces.js';
import type { PreflightProbes } from './preflight.js';

export function realProbes(config: Config, chain: ChainAdapter): PreflightProbes {
  const docker = new Docker();
  return {
    dockerPing: async () => { await docker.ping(); },
    dockerImage: async (image: string) => { await docker.getImage(image).inspect(); },
    // eth_chainId proves WHICH chain answered; eth_blockNumber proves it is actually serving state.
    // An endpoint that knows its id but has no head block reads every balance as zero.
    chainHead: async (rpcUrl: string) => {
      const client = publicClientFor({ ...config.chain, rpcUrl });
      const [chainId, blockNumber] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
      return { chainId, blockNumber: Number(blockNumber) };
    },
    treasuryGwei: async () => chain.getEthBalance(getProtocolWallets(config).treasury.pubkey),
  };
}

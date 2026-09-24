// Build + send an ERC-20 USDC transfer with the connected wallet. Returns the transaction hash.
//
// This replaces the SPL version, which had to create the destination's associated token account
// before it could pay it. ERC-20 has no such thing: a balance is a row in the token's own mapping,
// so the transfer is one call and the recipient needs no setup. What EVM adds instead is that a
// transaction can be mined and still revert, so a `reverted` receipt is a failure here, never a
// success — the same rule the API applies on its side.
import { useCallback } from 'react';
import { encodeFunctionData, getAddress, parseAbi, type Address, type PublicClient, type WalletClient } from 'viem';
import type { Micro } from '@vantra/shared';
import { useWallet, usePublicClient } from '../providers/WalletProvider';
import { useAppStore } from '../store/app';

// USDC on Robinhood Chain is 6-decimal, so a Micro IS one base unit and no scaling happens anywhere.
const USDC_DECIMALS = 6;
const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

const CONFIRM_TIMEOUT_MS = 90_000;

export interface UsdcTransferParams {
  publicClient: PublicClient;
  walletClient: WalletClient;
  owner: Address;
  usdcMint: string;
  to: string;
  amountMicro: Micro;
  /** Kept for the callers that pass one; EVM has no memo program, and the ledger already records it. */
  memo?: string;
}

export async function sendUsdcTransfer(p: UsdcTransferParams): Promise<string> {
  if (!Number.isInteger(p.amountMicro) || p.amountMicro <= 0) throw new Error('Amount must be a positive whole number of micro-USDC');
  const token = getAddress(p.usdcMint);
  const to = getAddress(p.to);
  const amount = BigInt(p.amountMicro);

  // Decimals are read rather than assumed: paying a 18-decimal token as if it were 6-decimal would
  // send a millionth of the intended amount and look like a success.
  const [balance, decimals] = await Promise.all([
    p.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [p.owner] }),
    p.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }),
  ]);
  if (decimals !== USDC_DECIMALS) throw new Error(`Settlement token has ${decimals} decimals, expected ${USDC_DECIMALS}`);
  if (balance < amount) throw new Error('Insufficient USDC balance');

  const hash = await p.walletClient.sendTransaction({
    account: p.owner,
    chain: p.walletClient.chain,
    to: token,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, amount] }),
  });

  const receipt = await p.publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: CONFIRM_TIMEOUT_MS });
  // Landing is not succeeding. A reverted transfer moved nothing, and reporting its hash as a
  // payment would have the API verify a transaction that never credited anyone.
  if (receipt.status === 'reverted') throw new Error(`Transaction reverted on chain: ${hash}`);
  return hash;
}

export type UsdcSender = (to: string, amountMicro: Micro, memo?: string) => Promise<string>;

/** Hook form: binds the clients, the connected account and the configured USDC address. */
export function useUsdcTransfer(): UsdcSender {
  const publicClient = usePublicClient();
  const { publicKey, walletClient, wrongNetwork, chain } = useWallet();
  const usdcMint = useAppStore((s) => s.stats?.chain.usdcMint ?? null);

  return useCallback(
    async (to, amountMicro, memo) => {
      if (!publicKey || !walletClient) throw new Error('Connect a wallet first');
      if (wrongNetwork) throw new Error(`Switch the wallet to ${chain.name} first`);
      if (!usdcMint) throw new Error('USDC address not loaded yet');
      return sendUsdcTransfer({
        publicClient, walletClient, owner: publicKey as Address, usdcMint, to, amountMicro, memo,
      });
    },
    [publicClient, publicKey, walletClient, wrongNetwork, chain, usdcMint],
  );
}

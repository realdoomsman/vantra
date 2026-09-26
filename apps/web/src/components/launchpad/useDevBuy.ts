// The dev's opening buy: right after the launch is confirmed, the dev's wallet buys on the coin's own
// bonding curve with the ETH they set aside. Pons's factory takes exactly its fee in the launch call,
// so this cannot ride in the same transaction; it is the next one, and the deployer is exempt from
// Pons's snipe tax, so it clears at the opening price all the same.
//
// The curve is quoted client-side from its own verified math (fee and tax off the input, then constant
// product over the reserves), and `minTokensOut` is set 2% under that, so a curve that has already
// moved against the dev fails the buy instead of filling it badly. Nothing is signed for the dev.
import { useCallback, useState } from 'react';
import { encodeFunctionData, parseAbi, parseEventLogs, type Address } from 'viem';
import { usePublicClient, useWallet } from '../../providers/WalletProvider';

/** The slice of PonsV2BondingCurve this hook uses (contractsV2/src/v2/PonsV2BondingCurve.sol). */
const curveAbi = parseAbi([
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
]);

const BPS = 10_000n;
const SLIPPAGE_BPS = 200n;
const RECEIPT_TIMEOUT_MS = 120_000;

export type DevBuy =
  | { kind: 'idle' }
  | { kind: 'running'; hash: string | null }
  | { kind: 'done'; hash: string; tokensOut: bigint }
  | { kind: 'failed'; message: string };

export function useDevBuy() {
  const [state, setState] = useState<DevBuy>({ kind: 'idle' });
  const publicClient = usePublicClient();
  const { publicKey, walletClient } = useWallet();

  const buy = useCallback(
    async (curve: string, wei: bigint) => {
      setState({ kind: 'running', hash: null });
      try {
        if (!publicKey || !walletClient) throw new Error('Connect the wallet first.');
        const to = curve as Address;
        const [feeBps, taxBps, [quoteReserve, tokenReserve]] = await Promise.all([
          publicClient.readContract({ address: to, abi: curveAbi, functionName: 'feeBps' }),
          publicClient.readContract({ address: to, abi: curveAbi, functionName: 'creatorTaxBps' }),
          publicClient.readContract({ address: to, abi: curveAbi, functionName: 'getReserves' }),
        ]);
        const net = wei - (wei * feeBps) / BPS - (wei * taxBps) / BPS;
        const expected = (net * tokenReserve) / (quoteReserve + net);
        if (expected <= 0n) throw new Error('The curve cannot fill that amount.');
        const minTokensOut = (expected * (BPS - SLIPPAGE_BPS)) / BPS;

        const hash = await walletClient.sendTransaction({
          account: publicKey as Address,
          chain: walletClient.chain,
          to,
          value: wei,
          data: encodeFunctionData({ abi: curveAbi, functionName: 'buy', args: [wei, minTokensOut, publicKey as Address] }),
        });
        setState({ kind: 'running', hash });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: RECEIPT_TIMEOUT_MS });
        if (receipt.status === 'reverted') throw new Error('The buy reverted on chain; only gas was spent.');
        const event = parseEventLogs({ abi: curveAbi, eventName: 'CurveBuy', logs: receipt.logs })[0];
        setState({ kind: 'done', hash, tokensOut: event?.args.tokensOut ?? expected });
      } catch (e) {
        const short = e && typeof e === 'object' && 'shortMessage' in e && typeof e.shortMessage === 'string' ? e.shortMessage : null;
        setState({ kind: 'failed', message: short ?? (e instanceof Error ? e.message : 'The buy did not go through.') });
      }
    },
    [publicClient, publicKey, walletClient],
  );

  const reset = useCallback(() => setState({ kind: 'idle' }), []);
  return { devBuy: state, buy, reset };
}

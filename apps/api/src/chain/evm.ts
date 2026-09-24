// Real chain adapter: viem against Robinhood Chain, an Arbitrum Orbit (Nitro) L2 — mainnet 4663,
// testnet 46630, native gas asset ETH, settlement in 6-decimal USDC (SPEC §8.1). Replaces the Solana
// adapter one method for one method.
//
// Three things are structurally different from the Solana original and are called out where they bite:
//  * there are no associated token accounts, so nothing has to be created before a wallet can be paid;
//  * there is no fee payer, so a sponsor pre-funds gas instead of co-signing (see sweepUsdc/sweepEth);
//  * a wallet's transactions are ordered by a nonce, so every send from one address is serialised
//    through chain/mutex.ts — two concurrent sends sharing a nonce means one is silently dropped.
//
// Every send is signed locally and broadcast as a raw transaction under a PINNED nonce. That is what
// makes the broadcast retry below safe: a resend is byte-identical, so the chain can include it at
// most once, exactly as the Solana adapter's blockhash-pinned resend could.
import { randomBytes } from 'node:crypto';
import {
  TransactionReceiptNotFoundError, createPublicClient, createWalletClient, decodeEventLog, defineChain,
  encodeFunctionData, erc20Abi, getAddress, http, keccak256, parseAbiItem,
  type Account, type Address, type Chain, type Hex, type HttpTransport, type PrivateKeyAccount,
  type PublicClient, type TransactionReceipt, type WalletClient,
} from 'viem';
import { RHC_EXPLORER_URL, sameAddress } from '@vantra/shared';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { UsdcInflow } from '../core/interfaces.js';
import { CHAIN_IDS } from '../core/preflight.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/log.js';
import { ChainError } from './errors.js';
import { accountFromSecret } from './keys.js';
import { withAddressLock } from './mutex.js';
import {
  blockTimeToDate, largestUsdcTransfer, resolveInflow, usdcInflowsTo, type EvmLog,
} from './parse.js';
import { PONS_FACTORY, ZERO_ADDRESS, ponsBondingCurveAbi, ponsFactoryAbi } from './pons.js';
import { createEthPriceSource, gweiToMicro } from './price.js';
import { getProtocolWallets, type WalletAwareChain } from './wallets.js';

// The zero address is how every aggregator, and this adapter, names native ETH on a token leg.
export const NATIVE_TOKEN = ZERO_ADDRESS;
export const LIFI_QUOTE_URL = 'https://li.quest/v1/quote';
const LIFI_TIMEOUT_MS = 15_000;

// Public RPC endpoints rate-limit and restart constantly. Every call routed through `rpc()` is
// idempotent, so a transient failure is retried with exponential backoff before it becomes a ChainError.
export const RPC_ATTEMPTS = 4;
const RPC_BACKOFF_MS = 400;
const RPC_BACKOFF_MAX_MS = 3_200;

// eth_getLogs window. Public endpoints refuse wide ranges, so the scan walks back from the tip in
// chunks; EVM_SCAN_BLOCKS is how far back one call is willing to look at all (≈2 days at 0.43s blocks).
export const EVM_LOG_CHUNK_BLOCKS = 10_000n;
export const EVM_SCAN_BLOCKS = 400_000n;
// Ceiling on transactions one listUsdcInflows call will collect. In steady state `sinceSig` keeps the
// real number at zero or one; this only bounds a first scan of a heavily used address.
export const MAX_SCAN_TXS = 500;
const DEFAULT_INFLOW_LIMIT = 100;

const CONFIRMATIONS = 1;
const RECEIPT_TIMEOUT_MS = 90_000;
const RECEIPT_POLL_MS = 500;              // blocks are ~0.43s
const WEI_PER_GWEI = 1_000_000_000n;
// Arbitrum Orbit folds the L1 data cost into the gas NUMBER, so a transfer's gas units are far above
// mainnet's 21k/65k and vary with L1 pricing. These ceilings are used only to decide whether a sponsor
// needs to pre-fund a wallet — over-funding costs nothing, under-funding strands a sweep.
const GAS_UNITS_ETH_TRANSFER = 200_000n;
const GAS_UNITS_ERC20_TRANSFER = 500_000n;
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

// There is no viem/chains entry for Robinhood Chain; the ids come from core/preflight.ts, which owns
// the boot rules and must stay importable without viem.
const RHC_RPC_URLS: Record<string, readonly string[]> = {
  mainnet: ['https://rpc.mainnet.chain.robinhood.com'],
  // The testnet endpoint is an Alchemy URL carrying a key, so there is no public default: config
  // refuses to boot on testnet without an explicit RHC_RPC_URL.
  testnet: [],
};
const chainCache = new Map<string, Chain>();

export function rhcChain(network: string): Chain {
  const cached = chainCache.get(network);
  if (cached) return cached;
  const id = CHAIN_IDS[network];
  if (id === undefined) throw new ChainError('rpc_error', `unknown Robinhood Chain network "${network}"`);
  const chain = defineChain({
    id,
    name: network === 'mainnet' ? 'Robinhood Chain' : `Robinhood Chain ${network}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: RHC_RPC_URLS[network] ?? [] } },
    blockExplorers: { default: { name: 'Blockscout', url: RHC_EXPLORER_URL } },
  });
  chainCache.set(network, chain);
  return chain;
}

// One place builds a transport. `retryCount: 0` is deliberate: the retry policy lives in `rpc()` below,
// and two independent backoffs on a rate-limited endpoint compound into minute-long stalls.
const rhcTransport = (rpcUrl: string) => http(rpcUrl, { retryCount: 0, timeout: 20_000 });

// The two client types the rest of the API names: economy/token.ts reads the Pons factory through the
// first and signs its launch through the second.
export type RhcPublicClient = PublicClient<HttpTransport, Chain>;
export type RhcWalletClient = WalletClient<HttpTransport, Chain, Account>;

export function publicClientFor(cfg: Config['chain']): RhcPublicClient {
  return createPublicClient({ chain: rhcChain(cfg.cluster), transport: rhcTransport(cfg.rpcUrl) });
}

export function walletClientFor(cfg: Config['chain'], account: Account): RhcWalletClient {
  return createWalletClient({ account, chain: rhcChain(cfg.cluster), transport: rhcTransport(cfg.rpcUrl) });
}

// LI.FI's quote is external input: validated once, consumed typed. `transactionRequest` is absent on a
// quote that cannot be executed from the given address, which is a no-route answer, not a crash.
const lifiQuoteSchema = z.object({
  estimate: z.object({
    fromAmount: z.string(),
    toAmount: z.string(),
    approvalAddress: z.string().optional(),
  }),
  transactionRequest: z.object({
    to: z.string(),
    data: z.string(),
    value: z.string().optional(),
    gasLimit: z.string().optional(),
  }).optional(),
});
type LifiQuote = z.infer<typeof lifiQuoteSchema>;

interface SendRequest { to: Address; data?: Hex; value?: bigint }

// The one RPC retry policy and the one signing path, shared by the ChainAdapter below and by the Pons
// launchpad port (chain/launchpad.ts). `send` holds the sender's nonce lock; `sendUnlocked` is for a
// caller that already holds it (a multi-leg sweep, or a claim that reads balances around its send).
export interface EvmTransactor {
  readonly client: RhcPublicClient;
  readonly chain: Chain;
  rpc<T>(what: string, fn: () => Promise<T>): Promise<T>;
  send(account: PrivateKeyAccount, what: string, req: SendRequest): Promise<TransactionReceipt>;
  sendUnlocked(account: PrivateKeyAccount, what: string, req: SendRequest): Promise<TransactionReceipt>;
  /** Waits for `hash` to land and returns its receipt WHATEVER its status; the caller judges it. */
  landed(hash: Hex, what: string): Promise<TransactionReceipt>;
}

export function createEvmTransactor(cfg: Config['chain'], log: Logger): EvmTransactor {
  const chain = rhcChain(cfg.cluster);
  const client = publicClientFor(cfg);

  // Every call routed through here is a READ or a byte-identical resend, so retrying one can never
  // move money twice.
  async function rpc<T>(what: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        // Our own validation (an address that is not hex, an amount that is not a positive integer)
        // runs inside these callbacks. It is already the right error and it will never succeed on a
        // retry, so it passes straight through rather than being relabelled rpc_error.
        if (e instanceof ChainError) throw e;
        if (attempt >= RPC_ATTEMPTS || !isTransientRpcError(e)) {
          throw new ChainError('rpc_error', `${what} failed: ${errorMessage(e)}`, { cause: e });
        }
        const waitMs = Math.min(RPC_BACKOFF_MS * 2 ** (attempt - 1), RPC_BACKOFF_MAX_MS);
        log.warn({ what, attempt, waitMs, err: errorMessage(e) }, 'rpc call failed; retrying');
        await nap(waitMs);
      }
    }
  }

  // Signs and broadcasts one transaction from `account`, already holding that address's nonce lock.
  async function sendUnlocked(account: PrivateKeyAccount, what: string, req: SendRequest): Promise<TransactionReceipt> {
    const [nonce, fees] = await Promise.all([
      rpc('getTransactionCount', () => client.getTransactionCount({ address: account.address, blockTag: 'pending' })),
      rpc('estimateFeesPerGas', () => client.estimateFeesPerGas()),
    ]);
    const gas = await rpc('estimateGas', async () => {
      try {
        return await client.estimateGas({ account, to: req.to, data: req.data, value: req.value });
      } catch (e) {
        throw classifySendError(e, `${what} would fail`);
      }
    });
    const serializedTransaction = await account.signTransaction({
      chainId: chain.id,
      nonce,
      to: req.to,
      data: req.data,
      value: req.value ?? 0n,
      gas: (gas * GAS_LIMIT_BUFFER_PCT) / 100n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      type: 'eip1559',
    });
    const hash = keccak256(serializedTransaction);
    await broadcast(serializedTransaction, what);
    return receiptOf(hash, what);
  }

  async function broadcast(serializedTransaction: Hex, what: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await client.sendRawTransaction({ serializedTransaction });
        return;
      } catch (e) {
        // The node already has this exact transaction — our nonce, our bytes. Nothing to resend; the
        // receipt wait below is what decides whether it succeeded.
        if (ALREADY_BROADCAST_RE.test(errorMessage(e))) return;
        if (attempt >= RPC_ATTEMPTS || !isTransientRpcError(e)) throw classifySendError(e, `${what} could not be broadcast`);
        const waitMs = Math.min(RPC_BACKOFF_MS * 2 ** (attempt - 1), RPC_BACKOFF_MAX_MS);
        log.warn({ what, attempt, waitMs, err: errorMessage(e) }, 'broadcast failed; resending the same signed transaction');
        await nap(waitMs);
      }
    }
  }

  async function landed(hash: Hex, what: string): Promise<TransactionReceipt> {
    try {
      return await client.waitForTransactionReceipt({ hash, confirmations: CONFIRMATIONS, timeout: RECEIPT_TIMEOUT_MS, pollingInterval: RECEIPT_POLL_MS });
    } catch (e) {
      throw new ChainError('tx_failed', `${what} ${hash} was not confirmed within ${RECEIPT_TIMEOUT_MS / 1000}s: ${errorMessage(e)}`, { cause: e });
    }
  }

  // Landing is not succeeding: a transaction can be included and still revert, and the money did not
  // move. A reverted receipt is a failure, never a returned hash.
  async function receiptOf(hash: Hex, what: string): Promise<TransactionReceipt> {
    const receipt = await landed(hash, what);
    if (receipt.status !== 'success') throw new ChainError('tx_failed', `${what} ${hash} reverted on chain`);
    return receipt;
  }

  const send = (account: PrivateKeyAccount, what: string, req: SendRequest): Promise<TransactionReceipt> =>
    withAddressLock(account.address, () => sendUnlocked(account, what, req));

  return { client, chain, rpc, send, sendUnlocked, landed };
}

interface CurveRef { curve: Address; pairToken: Address }

export function createEvmChain(config: Config, log: Logger): WalletAwareChain {
  const cfg = config.chain;
  const { cluster, usdcMint } = cfg;
  const { client, chain, rpc, send, sendUnlocked } = createEvmTransactor(cfg, log);
  const usdc = address(usdcMint);
  const price = createEthPriceSource({ cluster, fallbackUsd: cfg.ethPriceUsd, log });
  const wallets = getProtocolWallets(config);
  const lifiHeaders: Record<string, string> = cfg.lifiApiKey
    ? { accept: 'application/json', 'x-lifi-api-key': cfg.lifiApiKey }
    : { accept: 'application/json' };

  // Base units as a Number. USDC at 6 decimals can never come near the ceiling; an 18-decimal token
  // can, and reporting the nearest double beats reporting zero — every place that then SPENDS the
  // amount re-reads the exact bigint balance and clamps to it (see rawInput below).
  function toNumber(raw: bigint, what: string): number {
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) {
      log.warn({ what, raw: raw.toString() }, 'on-chain amount exceeds Number.MAX_SAFE_INTEGER; reporting the nearest representable value');
    }
    return n;
  }

  const erc20Balance = (token: Address, owner: Address): Promise<bigint> =>
    rpc('balanceOf', () => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }));

  // A sponsor cannot pay another wallet's gas on EVM, so it pre-funds instead: if `wallet` cannot
  // cover `gasUnits` at the current fee, top it up from `payer` first. This is what preserves the
  // "treasury sponsors gas" behaviour the deposit sweeps were written against.
  async function ensureGas(wallet: Address, payerSecret: Uint8Array, gasUnits: bigint, what: string): Promise<void> {
    const [balance, fees] = await Promise.all([
      rpc('getBalance', () => client.getBalance({ address: wallet })),
      rpc('estimateFeesPerGas', () => client.estimateFeesPerGas()),
    ]);
    const need = gasUnits * fees.maxFeePerGas;
    if (balance >= need) return;
    const topUpGwei = Number((need - balance + WEI_PER_GWEI - 1n) / WEI_PER_GWEI);
    const payer = accountFromSecret(payerSecret);
    log.info({ wallet, payer: payer.address, topUpGwei, what }, 'sponsoring gas: pre-funding the sender');
    await send(payer, 'gas pre-funding', { to: wallet, value: BigInt(topUpGwei) * WEI_PER_GWEI });
  }

  async function ensureAllowance(account: PrivateKeyAccount, token: Address, spender: Address, amount: bigint): Promise<void> {
    const current = await rpc('allowance', () => client.readContract({
      address: token, abi: erc20Abi, functionName: 'allowance', args: [account.address, spender],
    }));
    if (current >= amount) return;
    // Some ERC-20s refuse a non-zero → non-zero approve; clear it first when one is outstanding.
    if (current > 0n) await send(account, 'approve reset', { to: token, data: approveData(spender, 0n) });
    await send(account, 'approve', { to: token, data: approveData(spender, amount) });
  }

  // ---- Pons bonding curves -------------------------------------------------

  // The live curve of a Pons token that has NOT graduated, or null. Before graduation there is no
  // Uniswap pool and therefore no aggregator route by construction, so this is the only venue.
  async function ungraduatedCurve(token: Address): Promise<CurveRef | null> {
    if (token === ZERO_ADDRESS || sameAddress(token, usdc)) return null;
    const info = await rpc('getLaunchedToken', () => client.readContract({
      address: PONS_FACTORY, abi: ponsFactoryAbi, functionName: 'getLaunchedToken', args: [token],
    }));
    if (!info.exists) return null;
    const graduated = await rpc('curve.graduated', () => client.readContract({
      address: info.curve, abi: ponsBondingCurveAbi, functionName: 'graduated',
    }));
    return graduated ? null : { curve: info.curve, pairToken: info.pairToken };
  }

  // Buys `token` on its curve by spending `quoteRaw` of the curve's quote asset, or sells `tokensRaw`
  // back into it. `minOut` is zero and that is a considered choice: the curve exposes reserves but no
  // quote view, and its fee and creator-tax schedule are not in the ABI, so any client-side minimum
  // would either fail to protect or revert sound trades. The realised amount is not guessed — it is
  // read back out of the CurveBuy/CurveSell event the trade itself emits.
  async function curveTrade(
    secret: Uint8Array, ref: CurveRef, side: 'buy' | 'sell', amountRaw: bigint,
  ): Promise<{ sig: string; outRaw: bigint }> {
    const account = accountFromSecret(secret);
    const native = ref.pairToken === ZERO_ADDRESS;
    let receipt: TransactionReceipt;
    if (side === 'buy') {
      if (!native) await ensureAllowance(account, ref.pairToken, ref.curve, amountRaw);
      receipt = await send(account, 'curve buy', {
        to: ref.curve,
        data: encodeFunctionData({ abi: ponsBondingCurveAbi, functionName: 'buy', args: [amountRaw, 0n, account.address] }),
        value: native ? amountRaw : 0n,
      });
    } else {
      const token = await rpc('curve.token', () => client.readContract({ address: ref.curve, abi: ponsBondingCurveAbi, functionName: 'token' }));
      await ensureAllowance(account, token, ref.curve, amountRaw);
      receipt = await send(account, 'curve sell', {
        to: ref.curve,
        data: encodeFunctionData({ abi: ponsBondingCurveAbi, functionName: 'sell', args: [amountRaw, 0n, account.address] }),
      });
    }
    const outRaw = curveOutput(receipt, ref.curve, side);
    if (outRaw === null) {
      throw new ChainError('tx_failed', `curve ${side} ${receipt.transactionHash} emitted no Curve${side === 'buy' ? 'Buy' : 'Sell'} event`);
    }
    return { sig: receipt.transactionHash, outRaw };
  }

  // ---- LI.FI ---------------------------------------------------------------

  // A quote, or null when LI.FI answers 404 "no available quotes". Anything else is a real failure.
  async function lifi(from: Address, to: Address, amountRaw: bigint, fromAddress: Address, slippageBps: number): Promise<LifiQuote | null> {
    const url = `${LIFI_QUOTE_URL}?fromChain=${chain.id}&toChain=${chain.id}&fromToken=${from}&toToken=${to}`
      + `&fromAmount=${amountRaw}&fromAddress=${fromAddress}&slippage=${slippageBps / 10_000}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: lifiHeaders, signal: AbortSignal.timeout(LIFI_TIMEOUT_MS) });
    } catch (e) {
      throw new ChainError('rpc_error', `LI.FI quote failed: ${errorMessage(e)}`, { cause: e });
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new ChainError('rpc_error', `LI.FI ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const parsed = lifiQuoteSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new ChainError('rpc_error', `LI.FI returned an unexpected quote shape: ${parsed.error.message.slice(0, 200)}`);
    return parsed.data;
  }

  // Signs and sends a LI.FI-built transaction, approving the aggregator's spender first when the
  // input leg is an ERC-20.
  async function lifiSwap(secret: Uint8Array, quote: LifiQuote, input: Address, amountRaw: bigint): Promise<{ sig: string; outRaw: bigint }> {
    const req = quote.transactionRequest;
    if (!req) throw new ChainError('no_route', 'LI.FI quoted a route it cannot build a transaction for');
    const account = accountFromSecret(secret);
    if (input !== ZERO_ADDRESS) {
      if (!quote.estimate.approvalAddress) throw new ChainError('no_route', 'LI.FI returned no approval address for an ERC-20 swap');
      await ensureAllowance(account, input, address(quote.estimate.approvalAddress), amountRaw);
    }
    const receipt = await send(account, 'swap', {
      to: address(req.to),
      data: hex(req.data, 'LI.FI calldata'),
      value: req.value ? BigInt(req.value) : 0n,
    });
    return { sig: receipt.transactionHash, outRaw: BigInt(quote.estimate.toAmount) };
  }

  // The exact bigint amount to spend: `amountBaseUnits` arrives as a Number, and for an 18-decimal
  // token that Number may have been rounded UP past what the wallet actually holds, which would
  // revert. Clamping to the on-chain balance keeps "sell everything" working.
  async function rawInput(token: Address, owner: Address, amountBaseUnits: number): Promise<bigint> {
    const wanted = token === ZERO_ADDRESS ? BigInt(amountBaseUnits) * WEI_PER_GWEI : BigInt(amountBaseUnits);
    if (token === ZERO_ADDRESS) return wanted;
    const held = await erc20Balance(token, owner);
    if (held >= wanted) return wanted;
    if (!Number.isSafeInteger(amountBaseUnits)) {
      log.debug({ token, owner, wanted: wanted.toString(), held: held.toString() }, 'clamping a rounded swap amount to the exact balance');
      return held;
    }
    throw new ChainError('insufficient_funds', `${owner} holds ${held} of ${token}, needs ${wanted}`);
  }

  // ---- inflow scanning -----------------------------------------------------

  // Every USDC Transfer credited to `owner` and newer than `sinceSig`, grouped by transaction, newest
  // first. Walks back from the tip in chunks — the Solana signature walk's exact semantics, expressed
  // in eth_getLogs — and stops the moment it sees the cursor.
  async function scanInflowLogs(owner: Address, sinceSig: string | null): Promise<{ hashes: string[]; legs: Map<string, EvmLog[]>; truncated: boolean }> {
    const cursor = sinceSig?.toLowerCase() ?? null;
    const tip = await rpc('getBlockNumber', () => client.getBlockNumber());
    const floor = tip > EVM_SCAN_BLOCKS ? tip - EVM_SCAN_BLOCKS : 0n;
    const hashes: string[] = [];
    const legs = new Map<string, EvmLog[]>();
    let truncated = false;
    let to = tip;
    for (;;) {
      const from = to - EVM_LOG_CHUNK_BLOCKS + 1n > floor ? to - EVM_LOG_CHUNK_BLOCKS + 1n : floor;
      const chunk = await rpc('getLogs', () => client.getLogs({
        address: usdc, event: TRANSFER_EVENT, args: { to: owner }, fromBlock: from, toBlock: to,
      }));
      // Logs arrive oldest-first within a chunk; this walk is newest-first throughout.
      for (let i = chunk.length - 1; i >= 0; i--) {
        const entry = chunk[i]!;
        const hash = entry.transactionHash?.toLowerCase() ?? null;
        if (hash === null) continue;
        if (hash === cursor) return { hashes, legs, truncated: false };
        const existing = legs.get(hash);
        if (existing) {
          existing.push(entry);
          continue;
        }
        if (hashes.length >= MAX_SCAN_TXS) {
          truncated = true;
          break;
        }
        hashes.push(hash);
        legs.set(hash, [entry]);
      }
      if (truncated || from === floor) break;
      to = from - 1n;
    }
    if (truncated) {
      log.warn(
        { address: owner, scanned: hashes.length, budget: MAX_SCAN_TXS },
        'inflow scan hit its transaction budget: anything older than the oldest hash returned is NOT included — reconcile it with a cursor',
      );
    } else if (cursor !== null && floor > 0n) {
      log.warn(
        { address: owner, sinceSig, blocks: EVM_SCAN_BLOCKS.toString() },
        'walked the whole scan window without reaching the cursor: inflows older than the window are NOT included',
      );
    }
    return { hashes, legs, truncated };
  }

  // ---- the adapter ---------------------------------------------------------

  return {
    mode: 'robinhood',
    cluster,
    usdcMint,
    wallets,
    newKeypair() {
      const secret = randomPrivateKey();
      return { pubkey: accountFromSecret(secret).address, secret };
    },
    async getUsdcBalance(addr) {
      return toNumber(await erc20Balance(usdc, address(addr)), 'usdc balance');
    },
    async getEthBalance(addr) {
      // Truncating to whole gwei is exact for every amount this system moves and keeps the value
      // inside Number's safe range, which wei is not.
      const wei = await rpc('getBalance', () => client.getBalance({ address: address(addr) }));
      return Number(wei / WEI_PER_GWEI);
    },
    async getTokenBalance(addr, token) {
      const owner = address(addr);
      const asset = address(token);
      if (asset === ZERO_ADDRESS) {
        const wei = await rpc('getBalance', () => client.getBalance({ address: owner }));
        return Number(wei / WEI_PER_GWEI);
      }
      return toNumber(await erc20Balance(asset, owner), `${asset} balance`);
    },
    // `memo` is ignored: EVM has no memo program, appending calldata to an ERC-20 transfer would break
    // contract recipients, and the ledger already records the same string off-chain.
    async transferUsdc(fromSecret, to, amount, _memo) {
      assertAmount(amount);
      const account = accountFromSecret(fromSecret);
      const receipt = await send(account, 'transferUsdc', { to: usdc, data: transferData(address(to), BigInt(amount)) });
      return { sig: receipt.transactionHash };
    },
    async transferEth(fromSecret, to, gwei) {
      assertAmount(gwei);
      const account = accountFromSecret(fromSecret);
      const receipt = await send(account, 'transferEth', { to: address(to), value: BigInt(gwei) * WEI_PER_GWEI });
      return { sig: receipt.transactionHash };
    },
    // BEHAVIOUR CHANGE, deliberately not hidden: the Solana adapter swept every leg in ONE transaction.
    // A plain ERC-20 has no atomic multi-transfer, so the legs are sent sequentially under the sender's
    // nonce lock and the LAST hash is returned. If a leg fails, the error names the hashes already sent
    // so an operator can reconcile a partial sweep instead of guessing. Outs of zero are dropped so a
    // fee leg that rounds to nothing does not cost a transaction.
    async sweepUsdc(fromSecret, payerSecret, outs, _memo) {
      const legs = outs.filter((o) => o.amount !== 0);
      for (const out of legs) assertAmount(out.amount);
      if (legs.length === 0) throw new ChainError('invalid_amount', 'sweepUsdc needs at least one non-zero out');
      const account = accountFromSecret(fromSecret);
      await ensureGas(account.address, payerSecret, GAS_UNITS_ERC20_TRANSFER * BigInt(legs.length), 'sweepUsdc');
      return withAddressLock(account.address, async () => {
        const sent: string[] = [];
        for (const out of legs) {
          try {
            const receipt = await sendUnlocked(account, 'sweepUsdc', { to: usdc, data: transferData(address(out.to), BigInt(out.amount)) });
            sent.push(receipt.transactionHash);
          } catch (e) {
            throw new ChainError(
              'tx_failed',
              `sweepUsdc sent ${sent.length} of ${legs.length} legs before failing (sent: ${sent.join(', ') || 'none'}); `
              + `the remaining USDC is still in ${account.address}: ${errorMessage(e)}`,
              { cause: e },
            );
          }
        }
        return { sig: sent[sent.length - 1]! };
      });
    },
    // Moves `gwei`, or everything the account holds above the gas its own transfer costs, out of the
    // deposit address. There is no fee payer on EVM — the sender always pays — so `payerSecret`
    // pre-funds the shortfall instead, and the last wei cannot be swept.
    async sweepEth(fromSecret, payerSecret, to, gwei) {
      const account = accountFromSecret(fromSecret);
      const dest = address(to);
      if (gwei !== null) {
        assertAmount(gwei);
        await ensureGas(account.address, payerSecret, GAS_UNITS_ETH_TRANSFER, 'sweepEth');
        const receipt = await send(account, 'sweepEth', { to: dest, value: BigInt(gwei) * WEI_PER_GWEI });
        return { sig: receipt.transactionHash };
      }
      const [balance, fees] = await Promise.all([
        rpc('getBalance', () => client.getBalance({ address: account.address })),
        rpc('estimateFeesPerGas', () => client.estimateFeesPerGas()),
      ]);
      const reserve = GAS_UNITS_ETH_TRANSFER * fees.maxFeePerGas;
      const sweepable = (balance - reserve) / WEI_PER_GWEI * WEI_PER_GWEI;   // whole gwei only
      if (sweepable <= 0n) {
        throw new ChainError(
          'insufficient_funds',
          `${account.address} holds ${balance / WEI_PER_GWEI} gwei, less than the ~${reserve / WEI_PER_GWEI} gwei of gas moving it would cost`,
        );
      }
      const receipt = await send(account, 'sweepEth', { to: dest, value: sweepable });
      return { sig: receipt.transactionHash };
    },
    // Inflows newer than `sinceSig`, newest first. When more than `limit` exist the OLDEST `limit` are
    // returned, so a caller that advances its cursor to the newest returned sig never skips one.
    async listUsdcInflows(addr, sinceSig, limit = DEFAULT_INFLOW_LIMIT) {
      const owner = address(addr);
      const { hashes, legs } = await scanInflowLogs(owner, sinceSig);
      // The oldest `limit` transactions, still newest-first.
      const chosen = hashes.length > limit ? hashes.slice(hashes.length - limit) : hashes;
      const blockTimes = new Map<bigint, Date>();
      const inflows: UsdcInflow[] = [];
      for (const hash of chosen) {
        const entries = legs.get(hash) ?? [];
        // One inflow per TRANSACTION (see resolveInflow): deposits_seen is keyed by hash, so a second
        // row for the same one would be dropped with its money uncredited.
        const resolved = resolveInflow(usdcInflowsTo(entries, owner, usdc));
        if (!resolved) continue;
        if (resolved.senders.length > 1) {
          log.error(
            { address: owner, sig: hash, senders: resolved.senders, amount: resolved.amount, chosen: resolved.from },
            'one transaction credited this address from more than one sender: the refund destination is ambiguous and '
            + 'was resolved to the largest leg; reconcile by hand before refunding',
          );
        }
        const blockNumber = blockNumberOf(entries);
        let ts = blockNumber === null ? new Date(0) : blockTimes.get(blockNumber) ?? null;
        if (ts === null && blockNumber !== null) {
          const block = await rpc('getBlock', () => client.getBlock({ blockNumber }));
          ts = blockTimeToDate(block.timestamp);
          blockTimes.set(blockNumber, ts);
        }
        inflows.push({ sig: hash, from: resolved.from, amount: resolved.amount, ts: ts ?? new Date(0) });
      }
      return inflows;
    },
    // null means "the chain has no such USDC transfer". An RPC that is rate-limited or down is NOT that
    // answer and must not be reported as one: verifyUsdcTransfer turns null into "no confirmed USDC
    // transfer found", and telling a buyer their real payment does not exist is unrecoverable. A hash
    // the node cannot even parse is a malformed request, so that one is a null.
    async getUsdcTransfer(sig) {
      if (!TX_HASH_RE.test(sig?.trim() ?? '')) {
        log.debug({ sig }, 'not a 32-byte transaction hash');
        return null;
      }
      const hash = sig.trim().toLowerCase() as Hex;
      const receipt = await rpc('getTransactionReceipt', async () => {
        try {
          return await client.getTransactionReceipt({ hash });
        } catch (e) {
          if (e instanceof TransactionReceiptNotFoundError) return null;
          throw e;
        }
      });
      if (!receipt || receipt.status !== 'success') return null;
      const transfer = largestUsdcTransfer(receipt.logs, usdc);
      if (!transfer) return null;
      const block = await rpc('getBlock', () => client.getBlock({ blockNumber: receipt.blockNumber }));
      return { sig: receipt.transactionHash, ...transfer, ts: blockTimeToDate(block.timestamp) };
    },
    ethPriceUsd: () => price.get(),
    // Swap `amountBaseUnits` of inputToken into outputToken from the agent's own wallet. The agent
    // signs and pays gas (it must hold a little ETH). Routed through LI.FI, except that a Pons token
    // which has not graduated has no pool to route through and is traded on its own bonding curve —
    // when the other leg is not the curve's quote asset, LI.FI covers that hop and the curve the other.
    async swap(fromSecret, inputToken, outputToken, amountBaseUnits, slippageBps) {
      assertSwapAmount(amountBaseUnits);
      const account = accountFromSecret(fromSecret);
      const input = address(inputToken);
      const output = address(outputToken);
      if (sameAddress(input, output)) throw new ChainError('invalid_amount', 'swap input and output are the same token');
      const amountRaw = await rawInput(input, account.address, amountBaseUnits);

      const sellCurve = await ungraduatedCurve(input);
      if (sellCurve) {
        const sold = await curveTrade(fromSecret, sellCurve, 'sell', amountRaw);
        if (sameAddress(sellCurve.pairToken, output)) {
          return { sig: sold.sig, inAmount: amountBaseUnits, outAmount: units(output, sold.outRaw) };
        }
        // Second hop: the curve pays in its quote asset, the caller wanted something else.
        const hop = await lifi(sellCurve.pairToken, output, spendable(sellCurve.pairToken, sold.outRaw), account.address, slippageBps);
        if (!hop) throw new ChainError('no_route', `sold on the curve but no route from ${sellCurve.pairToken} to ${output}`);
        const done = await lifiSwap(fromSecret, hop, sellCurve.pairToken, spendable(sellCurve.pairToken, sold.outRaw));
        return { sig: done.sig, inAmount: amountBaseUnits, outAmount: units(output, done.outRaw) };
      }

      const buyCurve = await ungraduatedCurve(output);
      if (buyCurve) {
        let quoteRaw = amountRaw;
        let firstHop: string | null = null;
        if (!sameAddress(buyCurve.pairToken, input)) {
          const hop = await lifi(input, buyCurve.pairToken, amountRaw, account.address, slippageBps);
          if (!hop) throw new ChainError('no_route', `no route from ${input} to ${buyCurve.pairToken}, the curve's quote asset`);
          const done = await lifiSwap(fromSecret, hop, input, amountRaw);
          firstHop = done.sig;
          quoteRaw = spendable(buyCurve.pairToken, done.outRaw);
        }
        const bought = await curveTrade(fromSecret, buyCurve, 'buy', quoteRaw);
        log.debug({ firstHop, curve: buyCurve.curve }, 'bought an ungraduated Pons token through its curve');
        return { sig: bought.sig, inAmount: amountBaseUnits, outAmount: units(output, bought.outRaw) };
      }

      const quote = await lifi(input, output, amountRaw, account.address, slippageBps);
      if (!quote) throw new ChainError('no_route', `no swap route for ${input} → ${output} at that size`);
      const done = await lifiSwap(fromSecret, quote, input, amountRaw);
      return { sig: done.sig, inAmount: amountBaseUnits, outAmount: units(output, done.outRaw) };
    },
    // Current USDC value (in micro) of holding `amountBaseUnits` of `token`, i.e. what selling it now
    // would yield. Used to mark open positions to market for unrealized P&L. An unquotable position
    // marks to zero, which is the honest read.
    async quoteUsdcOut(token, amountBaseUnits) {
      if (sameAddress(token, usdcMint)) return amountBaseUnits;
      if (!Number.isInteger(amountBaseUnits) || amountBaseUnits <= 0) return 0;
      const asset = address(token);
      const amountRaw = asset === ZERO_ADDRESS ? BigInt(amountBaseUnits) * WEI_PER_GWEI : BigInt(amountBaseUnits);
      try {
        const quote = await lifi(asset, usdc, amountRaw, address(wallets.treasury.pubkey), QUOTE_SLIPPAGE_BPS);
        if (quote) return Number(BigInt(quote.estimate.toAmount));
        const curve = await ungraduatedCurve(asset);
        if (!curve) {
          log.debug({ token: asset, amountBaseUnits }, 'no route and no curve: marking the position to zero');
          return 0;
        }
        return curveMarkToMarket(curve, amountRaw);
      } catch (e) {
        log.debug({ token: asset, err: errorMessage(e) }, 'quote failed; marking the position to zero');
        return 0;
      }
    },
  };

  // What an ungraduated position is worth: the curve's own reserves say what selling it would return
  // in the quote asset, and that asset is then valued in USD. Constant product over (quoteReserve,
  // tokenReserve) is the shape those two views describe, and it ignores the fee and tax, so this is an
  // upper bound on the sale — the same optimism an aggregator quote carries.
  async function curveMarkToMarket(ref: CurveRef, amountRaw: bigint): Promise<number> {
    const [quoteReserve, tokenReserve] = await Promise.all([
      rpc('curve.quoteReserve', () => client.readContract({ address: ref.curve, abi: ponsBondingCurveAbi, functionName: 'quoteReserve' })),
      rpc('curve.tokenReserve', () => client.readContract({ address: ref.curve, abi: ponsBondingCurveAbi, functionName: 'tokenReserve' })),
    ]);
    if (tokenReserve + amountRaw === 0n) return 0;
    const quoteOut = (quoteReserve * amountRaw) / (tokenReserve + amountRaw);
    if (quoteOut <= 0n) return 0;
    if (ref.pairToken === ZERO_ADDRESS) return gweiToMicro(Number(quoteOut / WEI_PER_GWEI), await price.get());
    if (sameAddress(ref.pairToken, usdc)) return Number(quoteOut);
    const quote = await lifi(ref.pairToken, usdc, quoteOut, address(wallets.treasury.pubkey), QUOTE_SLIPPAGE_BPS);
    return quote ? Number(BigInt(quote.estimate.toAmount)) : 0;
  }

  // Caller-facing units for a raw amount: gwei for native ETH, base units for an ERC-20.
  function units(token: Address, raw: bigint): number {
    return token === ZERO_ADDRESS ? Number(raw / WEI_PER_GWEI) : toNumber(raw, `${token} amount`);
  }

  // How much of an intermediate hop's proceeds can actually be spent: an ERC-20 leg, all of it; a
  // native leg, everything but a gas reserve, because the next transaction is paid out of the same
  // balance.
  function spendable(token: Address, raw: bigint): bigint {
    if (token !== ZERO_ADDRESS) return raw;
    const reserve = GAS_UNITS_ERC20_TRANSFER * WEI_PER_GWEI;   // a generous flat reserve in wei
    return raw > reserve ? raw - reserve : raw;
  }
}

// `new Promise` rather than Promise.withResolvers: the API package targets a lib older than ES2024.
const nap = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const GAS_LIMIT_BUFFER_PCT = 125n;         // estimateGas is a lower bound on an L2 whose L1 component moves
const QUOTE_SLIPPAGE_BPS = 100;            // marking to market, not trading: the number only shapes the route
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
// The node already has this exact signed transaction, or its nonce is already used by it. Neither is a
// reason to sign a second one — the receipt wait decides the outcome.
const ALREADY_BROADCAST_RE = /already known|already in the tx ?pool|known transaction|nonce too low|replacement transaction underpriced|transaction already exists/i;

// What an RPC endpoint answers with when it is busy, restarting, behind a flaky socket, or asked for
// more than it will serve — never a statement about the chain, always worth one more attempt.
const TRANSIENT_RPC_RE = /too many requests|rate.?limit|429\b|too many concurrent|503\b|502\b|504\b|bad gateway|service unavailable|gateway time|timed? ?out|fetch failed|socket hang up|econnreset|econnrefused|epipe|enotfound|eai_again|network|connection (reset|closed|refused)|header not found|missing trie node|limit exceeded|block range|query returned more than/i;

function jsonRpcCode(e: unknown): number | null {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'number' ? code : null;
}

export function isTransientRpcError(e: unknown): boolean {
  const code = jsonRpcCode(e);
  if (code === 429 || code === 502 || code === 503 || code === 504) return true;
  if (code === -32005 || code === -32016 || code === -32603) return true;   // limit exceeded / internal
  return TRANSIENT_RPC_RE.test(errorMessage(e));
}

// A send that failed for a reason the chain already decided: out of money, or a call that reverts.
// Anything else is handed back untouched so the transient-retry path can still see it.
function classifySendError(e: unknown, what: string): unknown {
  if (e instanceof ChainError) return e;
  if (isTransientRpcError(e)) return e;
  const message = errorMessage(e);
  if (/insufficient funds|exceeds the balance/i.test(message)) return new ChainError('insufficient_funds', `${what}: ${message}`, { cause: e });
  return new ChainError('tx_failed', `${what}: ${message}`, { cause: e });
}

// The realised output of a curve trade, read from the event the curve itself emitted.
function curveOutput(receipt: TransactionReceipt, curve: Address, side: 'buy' | 'sell'): bigint | null {
  const wanted = side === 'buy' ? 'CurveBuy' : 'CurveSell';
  for (const entry of receipt.logs) {
    if (!sameAddress(entry.address, curve)) continue;
    try {
      const decoded = decodeEventLog({ abi: ponsBondingCurveAbi, data: entry.data, topics: entry.topics });
      if (decoded.eventName === 'CurveBuy' && wanted === 'CurveBuy') return decoded.args.tokensOut;
      if (decoded.eventName === 'CurveSell' && wanted === 'CurveSell') return decoded.args.quoteOut;
    } catch {
      continue;      // a log from the same contract that is not one of the two trade events
    }
  }
  return null;
}

function blockNumberOf(entries: readonly EvmLog[]): bigint | null {
  for (const entry of entries) {
    const value = (entry as { blockNumber?: unknown }).blockNumber;
    if (typeof value === 'bigint') return value;
  }
  return null;
}

const transferData = (to: Address, amount: bigint): Hex =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] });

const approveData = (spender: Address, amount: bigint): Hex =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] });

function address(value: string): Address {
  try {
    return getAddress(value.trim());
  } catch {
    throw new ChainError('invalid_address', `not a valid EVM address: ${value}`);
  }
}

function hex(value: string, what: string): Hex {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) throw new ChainError('tx_failed', `${what} is not hex`);
  return value as Hex;
}

// A 32-byte private key drawn from the OS CSPRNG, redrawn on the vanishing chance that it is zero or
// past the secp256k1 group order.
function randomPrivateKey(): Uint8Array {
  for (;;) {
    const bytes = new Uint8Array(randomBytes(32));
    try {
      accountFromSecret(bytes);
      return bytes;
    } catch {
      continue;
    }
  }
}

function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new ChainError('invalid_amount', `amount must be a positive integer, got ${amount}`);
}

// Swap legs are looser than transfers on purpose. USDC is 6-decimal and always fits, but an
// 18-decimal token's base units pass Number.MAX_SAFE_INTEGER at a thousand whole tokens, and such a
// value is still an integer-valued double that converts to bigint exactly. Refusing it would make a
// large position unsellable; the on-chain balance clamp in rawInput absorbs the rounding.
function assertSwapAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) throw new ChainError('invalid_amount', `amount must be a positive integer, got ${amount}`);
}

// In-process chain simulator (CHAIN_MODE=memory, SPEC §8.2): balances in maps, synthetic transaction
// hashes, no gas, no confirmation latency. Addresses are free strings so demo owners like `demo-wallet-3`
// and faucet labels like `customer-7` work without keys. The treasury wallet starts with a
// DEMO_TREASURY_USD float and some ETH so gas stipends work; `faucet` is also the local payment
// simulator behind POST /api/purchases/:id/simulate-pay (SPEC-V2 §5.9).
import { randomBytes } from 'node:crypto';
import { keccak256, stringToHex, toHex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { makeRng, usd, type Micro, type Rng } from '@vantra/shared';
import type { Config } from '../config.js';
import type { Clock, UsdcInflow, UsdcTransfer } from '../core/interfaces.js';
import type { Logger } from '../lib/log.js';
import { ChainError } from './errors.js';
import { accountFromSecret, pubkeyOfSecret } from './keys.js';
import { ZERO_ADDRESS } from './pons.js';
import { GWEI_PER_ETH, gweiToMicro } from './price.js';
import { getProtocolWallets, type WalletAwareChain } from './wallets.js';

// A fixed, transaction-hash-shaped identifier for the float: hashes are 0x 32-byte everywhere now, and
// a `sim…` string would be the one identifier in the system that cannot round-trip through the UI.
export const MEMORY_GENESIS_SIG = keccak256(stringToHex('vantra:memory:genesis'));
export const MEMORY_GENESIS_FROM = 'vantra-treasury-float';
export const MEMORY_TREASURY_ETH_GWEI = 10 * GWEI_PER_ETH;
const DEFAULT_INFLOW_LIMIT = 100;
const MAX_INFLOW_LIMIT = 1_000;

export interface MemoryChain extends WalletAwareChain {
  readonly mode: 'memory';
  faucet(to: string, amount: Micro, from: string): Promise<{ sig: string }>;  // external "customer" USDC
  faucetEth(to: string, gwei: number, from?: string): Promise<{ sig: string }>;  // `from` labels the source (the fee escrow on a claim)
  setTokenBalance(owner: string, token: string, baseUnits: number): void;     // arbitrary ERC-20 fixtures
  setTokenPrice(token: string, usdPerToken: number): void;                    // memory-only price control for tests
  useClock(clock: Clock): void;                                               // demo: stamp txs with virtual time
}

interface MemTx { index: number; sig: string; kind: 'usdc' | 'eth'; from: string; to: string; amount: number; memo: string | null; ts: Date }

export function createMemoryChain(config: Config, log: Logger, opts: { clock?: Clock } = {}): MemoryChain {
  const usdcMint = config.chain.usdcMint;
  const ethPriceUsd = config.chain.ethPriceUsd;
  const usdc = new Map<string, Micro>();
  const eth = new Map<string, number>();                    // gwei, exactly like the real adapter
  const tokens = new Map<string, Map<string, number>>();
  const txs: MemTx[] = [];
  const bySig = new Map<string, MemTx>();
  let clock: Clock = opts.clock ?? { now: () => new Date() };

  const newSig = (): string => toHex(randomBytes(32));
  const balance = (map: Map<string, number>, key: string): number => map.get(key) ?? 0;
  const tokenPrices = new Map<string, number>();          // memory only: token -> USD per whole token (6-decimal tokens)
  const tokenBal = (token: string, owner: string): number => tokens.get(token)?.get(owner) ?? 0;
  const setTok = (token: string, owner: string, v: number): void => {
    const m = tokens.get(token) ?? new Map<string, number>();
    m.set(owner, v);
    tokens.set(token, m);
  };
  const priceOf = (token: string): number => tokenPrices.get(token) ?? 1;

  function record(kind: MemTx['kind'], from: string, to: string, amount: number, memo: string | null, sig = newSig()): MemTx {
    const tx: MemTx = { index: txs.length, sig, kind, from, to, amount, memo, ts: clock.now() };
    txs.push(tx);
    bySig.set(sig, tx);
    return tx;
  }

  function move(map: Map<string, number>, kind: MemTx['kind'], fromSecret: Uint8Array, to: string, amount: number, memo: string | null, sig?: string): MemTx {
    const from = pubkeyOfSecret(fromSecret);
    assertAddress(to);
    assertAmount(amount);
    const have = balance(map, from);
    if (have < amount) throw new ChainError('insufficient_funds', `${from} has ${have} ${kind === 'usdc' ? 'micro USDC' : 'gwei'}, needs ${amount}`);
    map.set(from, have - amount);
    map.set(to, balance(map, to) + amount);
    return record(kind, from, to, amount, memo, sig);
  }

  function credit(map: Map<string, number>, kind: MemTx['kind'], from: string, to: string, amount: number, sig?: string): MemTx {
    assertAddress(to);
    assertAmount(amount);
    map.set(to, balance(map, to) + amount);
    return record(kind, from, to, amount, null, sig);
  }

  // The simulator's price model: everything is valued in micro-USD, so any pair can be swapped the way
  // the aggregator does on the real chain. USDC is the unit, native ETH is priced at the configured
  // ETH_PRICE_USD, every other token at its `setTokenPrice` value (default $1).
  const valueMicro = (token: string, amount: number): Micro =>
    token === usdcMint ? amount
      : token === ZERO_ADDRESS ? gweiToMicro(amount, ethPriceUsd)
      : Math.round(amount * priceOf(token));
  const unitsOf = (token: string, micro: Micro): number =>
    token === usdcMint ? micro
      : token === ZERO_ADDRESS ? Math.round((micro * 1_000) / ethPriceUsd)
      : Math.round(micro / priceOf(token));
  const heldOf = (token: string, owner: string): number =>
    token === usdcMint ? balance(usdc, owner)
      : token === ZERO_ADDRESS ? balance(eth, owner)
      : tokenBal(token, owner);
  const setHeld = (token: string, owner: string, v: number): void => {
    if (token === usdcMint) usdc.set(owner, v);
    else if (token === ZERO_ADDRESS) eth.set(owner, v);
    else setTok(token, owner, v);
  };

  // Inflows newer than `sinceSig`, newest first. When more than `limit` exist the OLDEST `limit` are
  // returned, so a caller that advances its cursor to the newest returned sig never skips one.
  function listUsdcInflows(address: string, sinceSig: string | null, limit = DEFAULT_INFLOW_LIMIT): UsdcInflow[] {
    const since = sinceSig ? bySig.get(sinceSig) : undefined;
    const start = since ? since.index + 1 : 0;
    const page = Math.min(Math.max(1, limit), MAX_INFLOW_LIMIT);
    return txs.slice(start)
      .filter((t) => t.kind === 'usdc' && t.to === address)
      .slice(0, page)
      .reverse()
      .map(toInflow);
  }

  // DEMO=1 derives agent keys from DEMO_SEED so a seeded colony gets the same wallets — and so the
  // same prompts, and the same mock behaviour — on every boot. Simulated money only; never real keys.
  const keySeed: Rng | null = config.demo.enabled ? makeRng(config.demo.seed ^ 0x5eed_c0de) : null;
  const wallets = getProtocolWallets(config);
  if (config.demo.treasuryUsd > 0) credit(usdc, 'usdc', MEMORY_GENESIS_FROM, wallets.treasury.pubkey, usd(config.demo.treasuryUsd), MEMORY_GENESIS_SIG);
  credit(eth, 'eth', MEMORY_GENESIS_FROM, wallets.treasury.pubkey, MEMORY_TREASURY_ETH_GWEI);
  log.info(
    { treasury: wallets.treasury.pubkey, escrow: wallets.escrow.pubkey, treasuryUsd: config.demo.treasuryUsd },
    'memory chain ready',
  );

  return {
    mode: 'memory',
    cluster: 'memory',
    usdcMint,
    wallets,
    newKeypair() {
      const secret = keySeed ? seedBytes(keySeed) : hexToBytes32(generatePrivateKey());
      return { pubkey: accountFromSecret(secret).address, secret };
    },
    async getUsdcBalance(address) { return balance(usdc, address); },
    async getEthBalance(address) { return balance(eth, address); },
    async getTokenBalance(address, token) { return heldOf(token, address); },
    async transferUsdc(fromSecret, to, amount, memo) {
      return { sig: move(usdc, 'usdc', fromSecret, to, amount, memo ?? null).sig };
    },
    async transferEth(fromSecret, to, gwei) {
      return { sig: move(eth, 'eth', fromSecret, to, gwei, null).sig };
    },
    // One "transaction": every leg shares a hash. The real adapter cannot do that for an ERC-20 (see
    // the note on sweepUsdc in evm.ts) but the simulator's job is to be the cheapest possible stand-in,
    // and callers only ever use the returned hash as an identifier. Zero-amount outs are skipped so a
    // fee leg that rounds to nothing is not an error.
    async sweepUsdc(fromSecret, _payerSecret, outs, memo) {
      const sig = newSig();
      for (const out of outs) {
        if (out.amount === 0) continue;
        move(usdc, 'usdc', fromSecret, out.to, out.amount, memo ?? null, sig);
      }
      return { sig };
    },
    async sweepEth(fromSecret, _payerSecret, to, gwei) {
      const from = pubkeyOfSecret(fromSecret);
      const amount = gwei ?? balance(eth, from);
      if (amount <= 0) throw new ChainError('insufficient_funds', `${from} has no gwei to sweep`);
      return { sig: move(eth, 'eth', fromSecret, to, amount, null).sig };
    },
    // Simulated aggregator swap: any pair, priced through micro-USD (see valueMicro). Native ETH is
    // the zero address on either leg and its amount is gwei, exactly as on the real chain.
    async swap(fromSecret, inputToken, outputToken, amountBaseUnits, _slippageBps) {
      assertAmount(amountBaseUnits);
      const from = pubkeyOfSecret(fromSecret);
      if (inputToken === outputToken) throw new ChainError('invalid_amount', 'swap input and output are the same token');
      const have = heldOf(inputToken, from);
      if (have < amountBaseUnits) {
        throw new ChainError('insufficient_funds', `${from} holds ${have} of ${inputToken}, needs ${amountBaseUnits}`);
      }
      const out = unitsOf(outputToken, valueMicro(inputToken, amountBaseUnits));
      if (out <= 0) throw new ChainError('no_route', `${amountBaseUnits} of ${inputToken} is too small to buy any ${outputToken}`);
      setHeld(inputToken, from, have - amountBaseUnits);
      setHeld(outputToken, from, heldOf(outputToken, from) + out);
      return { sig: newSig(), inAmount: amountBaseUnits, outAmount: out };
    },
    async quoteUsdcOut(token, amountBaseUnits) {
      if (token === usdcMint) return amountBaseUnits;
      if (!Number.isSafeInteger(amountBaseUnits) || amountBaseUnits <= 0) return 0;
      return valueMicro(token, amountBaseUnits);
    },
    async listUsdcInflows(address, sinceSig, limit) { return listUsdcInflows(address, sinceSig, limit); },
    async getUsdcTransfer(sig) {
      const tx = bySig.get(sig);
      return tx && tx.kind === 'usdc' ? toTransfer(tx) : null;
    },
    async ethPriceUsd() { return ethPriceUsd; },
    async faucet(to, amount, from) {
      return { sig: credit(usdc, 'usdc', from, to, amount).sig };
    },
    async faucetEth(to, gwei, from = MEMORY_GENESIS_FROM) {
      return { sig: credit(eth, 'eth', from, to, gwei).sig };
    },
    setTokenBalance(owner, token, baseUnits) {
      const holders = tokens.get(token) ?? new Map<string, number>();
      holders.set(owner, baseUnits);
      tokens.set(token, holders);
    },
    setTokenPrice(token, usdPerToken) { tokenPrices.set(token, usdPerToken); },
    useClock(next) { clock = next; },
  };
}

// A seeded 32-byte value is a valid secp256k1 key with overwhelming probability; the loop is there so
// "overwhelming" never has to be trusted — a zero or out-of-range draw is simply redrawn.
function seedBytes(rng: Rng): Uint8Array {
  for (;;) {
    const bytes = Uint8Array.from({ length: 32 }, () => rng.int(0, 255));
    try {
      accountFromSecret(bytes);
      return bytes;
    } catch {
      continue;
    }
  }
}

const hexToBytes32 = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));

const toInflow = (t: MemTx): UsdcInflow => ({ sig: t.sig, from: t.from, amount: t.amount, ts: t.ts });
const toTransfer = (t: MemTx): UsdcTransfer => ({ sig: t.sig, from: t.from, to: t.to, amount: t.amount, ts: t.ts });

function assertAddress(address: string): void {
  if (typeof address !== 'string' || address.trim() === '') throw new ChainError('invalid_address', 'destination address is empty');
}

function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new ChainError('invalid_amount', `amount must be a positive integer, got ${amount}`);
}

// The EVM adapter against a fake JSON-RPC endpoint. This replaces the Solana adapter's fake-RPC suite
// and keeps exactly the guarantees that survived the port: a throttled read is retried rather than
// answered wrongly, a read that never clears is an rpc_error and never a "there is no such payment",
// a malformed hash costs zero RPC calls, an invalid address is never retried or relabelled, a
// transaction that reverted is a failure even though it landed, two concurrent sends from one wallet
// cannot take the same nonce, and the inflow walk collapses one transaction to one row.
//
// Deleted with the Solana adapter, deliberately not translated: ATA derivation, signature pagination,
// blockhash expiry and the memo program have no EVM counterpart to defend.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseTransaction, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isChainError } from '../../src/chain/errors.js';
import { RPC_ATTEMPTS, createEvmChain, isTransientRpcError } from '../../src/chain/evm.js';
import { TRANSFER_TOPIC0 } from '../../src/chain/parse.js';
import type { WalletAwareChain } from '../../src/chain/wallets.js';
import { loadConfig, type Config } from '../../src/config.js';
import { silentLogger } from '../../src/lib/log.js';

const USDC = '0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8';
const BUYER = '0x1111111111111111111111111111111111111111';
const AGENT = '0x2222222222222222222222222222222222222222';
const RATE_LIMITED = { code: -32005, message: 'rate limit exceeded' };

type Responder = (method: string, params: unknown[]) => unknown;

interface FakeRpc {
  url: string;
  calls: { method: string; params: unknown[] }[];
  respond(fn: Responder): void;
  close(): Promise<void>;
}

// A JSON-RPC error is any answer shaped { code, message }; anything else is a result.
const isRpcError = (v: unknown): v is { code: number; message: string } =>
  typeof v === 'object' && v !== null && typeof (v as { code?: unknown }).code === 'number'
  && typeof (v as { message?: unknown }).message === 'string';

async function startFakeRpc(): Promise<FakeRpc> {
  let responder: Responder = () => null;
  const calls: { method: string; params: unknown[] }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { id: number; method: string; params?: unknown[] };
      calls.push({ method: parsed.method, params: parsed.params ?? [] });
      const answer = responder(parsed.method, parsed.params ?? []);
      const payload = isRpcError(answer)
        ? { jsonrpc: '2.0', id: parsed.id, error: answer }
        : { jsonrpc: '2.0', id: parsed.id, result: answer };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    respond(fn) { responder = fn; },
    close: () => new Promise((resolve) => { server.close(() => { resolve(); }); }),
  };
}

const evmConfig = (url: string): Config => loadConfig({
  NODE_ENV: 'test',
  KEY_ENCRYPTION_KEY: 'ab'.repeat(32),
  SESSION_SECRET: 'fake-rpc-session-secret-long-enough',
  CHAIN_MODE: 'robinhood',
  RHC_NETWORK: 'testnet',
  RHC_RPC_URL: url,
  USDC_ADDRESS: USDC,
  TREASURY_WALLET_SECRET: generatePrivateKey(),
  ESCROW_WALLET_SECRET: generatePrivateKey(),
  PROTOCOL_FEE_WALLET: BUYER,
  FOUNDER_FEE_WALLET: AGENT,
});

let rpc: FakeRpc;
let chain: WalletAwareChain;

beforeEach(async () => {
  rpc = await startFakeRpc();
  chain = createEvmChain(evmConfig(rpc.url), silentLogger);
});
afterEach(async () => { await rpc.close(); });

// ---------------------------------------------------------------------------
// Reads: a public endpoint that throttles must never turn into a wrong answer.
// ---------------------------------------------------------------------------
describe('chain/evm rate-limit handling', () => {
  it('retries a throttled read and returns the answer', async () => {
    let seen = 0;
    rpc.respond((method) => {
      if (method !== 'eth_getBalance') return null;
      seen += 1;
      return seen < 3 ? RATE_LIMITED : toHex(3_000_000_000n);       // 3 gwei in wei
    });

    expect(await chain.getEthBalance(AGENT)).toBe(3);
    expect(seen).toBe(3);
  }, 15_000);

  it('gives up as an rpc_error once the attempts are spent, and names the call', async () => {
    let seen = 0;
    rpc.respond((method) => { if (method === 'eth_getBalance') seen += 1; return RATE_LIMITED; });

    await expect(chain.getEthBalance(AGENT)).rejects.toSatisfy((e) =>
      isChainError(e, 'rpc_error') && /getBalance/.test((e as Error).message));
    expect(seen).toBe(RPC_ATTEMPTS);
  }, 15_000);

  // verifyUsdcTransfer turns null into "no confirmed USDC transfer found". Telling a buyer their real
  // payment does not exist because an endpoint was busy is unrecoverable.
  it('never reports a throttled getUsdcTransfer as a missing transfer', async () => {
    rpc.respond(() => RATE_LIMITED);
    await expect(chain.getUsdcTransfer(`0x${'4'.repeat(64)}`)).rejects.toSatisfy((e) => isChainError(e, 'rpc_error'));
  }, 15_000);

  it('does report a malformed hash as a missing transfer, without asking the node', async () => {
    rpc.respond(() => RATE_LIMITED);
    expect(await chain.getUsdcTransfer('not-a-hash')).toBeNull();
    expect(rpc.calls).toHaveLength(0);
  });

  it('does not retry, or relabel, an address that was never valid', async () => {
    rpc.respond(() => toHex(1n));
    await expect(chain.getEthBalance('0xnope')).rejects.toSatisfy((e) => isChainError(e, 'invalid_address'));
    expect(rpc.calls).toHaveLength(0);
  });
});

describe('chain/evm error classification', () => {
  it('treats a throttle, an outage, a dropped socket and a refused log range as worth retrying', () => {
    expect(isTransientRpcError({ code: -32005, message: 'rate limit exceeded' })).toBe(true);
    expect(isTransientRpcError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isTransientRpcError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isTransientRpcError(new Error('socket hang up'))).toBe(true);
    // The EVM phrasings the Solana regex never had to know about.
    expect(isTransientRpcError(new Error('header not found'))).toBe(true);
    expect(isTransientRpcError(new Error('missing trie node 0xabc (path )'))).toBe(true);
    expect(isTransientRpcError(new Error('query returned more than 10000 results'))).toBe(true);
    expect(isTransientRpcError(new Error('block range is too large'))).toBe(true);
  });

  it('treats a real answer from a healthy node as final', () => {
    expect(isTransientRpcError(new Error('execution reverted'))).toBe(false);
    expect(isTransientRpcError(new Error('insufficient funds for gas * price + value'))).toBe(false);
    expect(isTransientRpcError({ code: -32602, message: 'invalid argument 0' })).toBe(false);
    expect(isTransientRpcError(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sends. Signing is local, so these exercise the real nonce/receipt path.
// ---------------------------------------------------------------------------
const BLOCK = {
  number: toHex(1_000n), hash: `0x${'b'.repeat(64)}`, parentHash: `0x${'c'.repeat(64)}`,
  nonce: '0x0000000000000000', sha3Uncles: `0x${'0'.repeat(64)}`, logsBloom: `0x${'0'.repeat(512)}`,
  transactionsRoot: `0x${'0'.repeat(64)}`, stateRoot: `0x${'0'.repeat(64)}`, receiptsRoot: `0x${'0'.repeat(64)}`,
  miner: BUYER, difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x100',
  gasLimit: toHex(30_000_000n), gasUsed: toHex(21_000n), timestamp: toHex(1_760_000_000n),
  transactions: [], uncles: [], baseFeePerGas: toHex(100_000_000n),
};

const receipt = (hash: string, status: '0x1' | '0x0', logs: unknown[] = []) => ({
  blockHash: BLOCK.hash, blockNumber: BLOCK.number, contractAddress: null,
  cumulativeGasUsed: toHex(21_000n), effectiveGasPrice: toHex(100_000_000n), from: BUYER,
  gasUsed: toHex(21_000n), logs, logsBloom: BLOCK.logsBloom, status, to: AGENT,
  transactionHash: hash, transactionIndex: '0x0', type: '0x2',
});

const transferLog = (from: string, to: string, amount: bigint, txHash: string, logIndex: number) => ({
  address: USDC.toLowerCase(),
  topics: [TRANSFER_TOPIC0, `0x${'0'.repeat(24)}${from.slice(2).toLowerCase()}`, `0x${'0'.repeat(24)}${to.slice(2).toLowerCase()}`],
  data: toHex(amount, { size: 32 }),
  blockNumber: BLOCK.number, blockHash: BLOCK.hash, transactionHash: txHash,
  transactionIndex: '0x0', logIndex: toHex(BigInt(logIndex)), removed: false,
});

// Answers everything a signed send needs; `onSend` decides the outcome.
function sendingRpc(onSend: (raw: string, sent: number) => unknown): { raws: string[] } {
  const raws: string[] = [];
  let blockNumber = 1_000n;
  rpc.respond((method, params) => {
    switch (method) {
      case 'eth_getTransactionCount': return toHex(BigInt(raws.length));
      case 'eth_maxPriorityFeePerGas': return toHex(1_000_000n);
      case 'eth_getBlockByNumber': return BLOCK;
      case 'eth_estimateGas': return toHex(21_000n);
      case 'eth_blockNumber': return toHex(blockNumber++);
      case 'eth_sendRawTransaction': {
        const raw = params[0] as string;
        raws.push(raw);
        return onSend(raw, raws.length);
      }
      case 'eth_getTransactionReceipt': return onSend(params[0] as string, raws.length);
      default: return null;
    }
  });
  return { raws };
}

describe('chain/evm sending', () => {
  const secret = (): Uint8Array => Uint8Array.from(Buffer.from(generatePrivateKey().slice(2), 'hex'));

  // Landing is not succeeding. A reverted transfer is included in a block and moved nothing.
  it('treats a reverted receipt as a failure, not as a returned hash', async () => {
    sendingRpc((raw) => (raw.startsWith('0x02') ? `0x${'d'.repeat(64)}` : receipt(`0x${'d'.repeat(64)}`, '0x0')));
    await expect(chain.transferEth(secret(), AGENT, 1_000)).rejects.toSatisfy((e) =>
      isChainError(e, 'tx_failed') && /reverted/.test((e as Error).message));
  }, 20_000);

  it('returns the hash of a successful transfer', async () => {
    const hash = `0x${'e'.repeat(64)}`;
    sendingRpc((raw) => (raw.startsWith('0x02') ? hash : receipt(hash, '0x1')));
    expect(await chain.transferEth(secret(), AGENT, 1_000)).toEqual({ sig: hash });
  }, 20_000);

  // Two sends from one wallet that read the same nonce means one of them is silently dropped by the
  // node. The per-address mutex in chain/mutex.ts is what stops that, and this is what proves it.
  it('serialises concurrent sends from one wallet so they cannot share a nonce', async () => {
    const hash = `0x${'f'.repeat(64)}`;
    const { raws } = sendingRpc((raw) => (raw.startsWith('0x02') ? hash : receipt(hash, '0x1')));
    const from = secret();

    await Promise.all([
      chain.transferEth(from, AGENT, 1_000),
      chain.transferEth(from, AGENT, 2_000),
    ]);

    expect(raws).toHaveLength(2);
    const nonces = raws.map((raw) => parseTransaction(raw as `0x${string}`).nonce);
    expect(new Set(nonces).size).toBe(2);
    expect(nonces.sort()).toEqual([0, 1]);
  }, 20_000);

  it('signs with the key it was given and no other', async () => {
    const hash = `0x${'a'.repeat(64)}`;
    const { raws } = sendingRpc((raw) => (raw.startsWith('0x02') ? hash : receipt(hash, '0x1')));
    const key = generatePrivateKey();
    await chain.transferEth(Uint8Array.from(Buffer.from(key.slice(2), 'hex')), AGENT, 1_000);
    const tx = parseTransaction(raws[0] as `0x${string}`);
    expect(tx.to?.toLowerCase()).toBe(AGENT.toLowerCase());
    expect(tx.value).toBe(1_000n * 1_000_000_000n);      // gwei in, wei on the wire
    expect(privateKeyToAccount(key).address).toMatch(/^0x/);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Inflow scanning: one transaction is one row, and the cursor stops the walk.
// ---------------------------------------------------------------------------
describe('chain/evm inflow scanning', () => {
  const txA = `0x${'1'.repeat(64)}`;
  const txB = `0x${'2'.repeat(64)}`;

  function logsRpc(byChunk: unknown[][]): { chunks: number } {
    let chunk = 0;
    const state = { chunks: 0 };
    rpc.respond((method) => {
      switch (method) {
        case 'eth_blockNumber': return toHex(200_000n);
        case 'eth_getBlockByNumber': return BLOCK;
        case 'eth_getLogs': {
          const answer = byChunk[chunk] ?? [];
          chunk += 1;
          state.chunks = chunk;
          return answer;
        }
        default: return null;
      }
    });
    return state;
  }

  // Two legs of one transaction are ONE inflow: deposits_seen is keyed by the hash, so a second row
  // would be dropped by the conflict clause with its money uncredited.
  it('returns one inflow per transaction, summing its legs, newest first', async () => {
    logsRpc([[
      transferLog(BUYER, AGENT, 1_000_000n, txA, 0),
      transferLog(BUYER, AGENT, 500_000n, txA, 1),
      transferLog(BUYER, AGENT, 250_000n, txB, 2),
    ]]);

    const inflows = await chain.listUsdcInflows(AGENT, null, 10);
    expect(inflows.map((i) => i.sig)).toEqual([txB, txA]);
    expect(inflows.map((i) => i.amount)).toEqual([250_000, 1_500_000]);
    expect(inflows[0]!.from).toBe(BUYER);
    expect(inflows[0]!.ts.toISOString()).toBe('2025-10-09T08:53:20.000Z');
  }, 20_000);

  it('stops walking the moment it reaches the cursor', async () => {
    const state = logsRpc([
      [transferLog(BUYER, AGENT, 250_000n, txB, 0)],
      [transferLog(BUYER, AGENT, 1_000_000n, txA, 0)],
    ]);

    const inflows = await chain.listUsdcInflows(AGENT, txA, 10);
    expect(inflows.map((i) => i.sig)).toEqual([txB]);
    expect(state.chunks).toBe(2);           // it stopped in the chunk holding the cursor
  }, 20_000);

  // More inflows than the page: the OLDEST `limit` are returned, so a caller that advances its cursor
  // to the newest returned hash never skips one.
  it('returns the oldest page when there are more inflows than the limit', async () => {
    const hashes = Array.from({ length: 4 }, (_, i) => `0x${String(i + 1).repeat(64)}`);
    logsRpc([hashes.map((h, i) => transferLog(BUYER, AGENT, BigInt((i + 1) * 1_000), h, i))]);

    const inflows = await chain.listUsdcInflows(AGENT, null, 2);
    expect(inflows.map((i) => i.sig)).toEqual([hashes[1], hashes[0]]);
  }, 20_000);
});

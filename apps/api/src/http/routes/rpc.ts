// Browser-safe Robinhood Chain JSON-RPC proxy. The wallet pay flow (usdcTransfer.ts) needs to read a
// USDC balance, price the gas and poll a receipt from the browser. The public Robinhood RPC
// (rpc.mainnet.chain.robinhood.com) is keyless, rate-limited and carries no SLA — it throttles and
// 403s exactly those reads, which surfaced to buyers as the false "this wallet holds no USDC". This
// forwards a bounded set of methods to the server's OWN configured RPC (which may be a keyed provider
// such as Alchemy), so the key stays server-side and the browser gets a reliable endpoint on the same
// origin. Robinhood mode only.
//
// The allow-list is the entire security model, and it is a READ list. The browser signs and broadcasts
// through the user's own wallet, never through here, so nothing that writes state or produces a
// signature is reachable: a proxy that relays a broadcast is an open relay wearing this server's IP
// and this server's provider key. Those methods are refused by name, with their own error code, so the
// refusal is visible to a caller (and to a test) instead of looking like a typo in the method name.
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../core/interfaces.js';

// Everything the web pay flow calls and nothing more: chain identity, tip/receipt polling, an
// `eth_call` for `balanceOf`, the three fee reads viem needs to build a transfer, and `eth_getCode` so
// the UI can tell a contract destination from an EOA. `eth_getBlockByNumber` is here for two concrete
// reads: viem's `waitForTransactionReceipt` fetches the block to detect a replaced (sped-up) payment,
// and `estimateFeesPerGas` reads `baseFeePerGas` off the header. No `eth_getLogs` (unbounded), no
// filters (stateful), no `eth_getTransactionCount` (only a sender needs a nonce, and senders are the
// user's own wallet).
export const RPC_ALLOWED_METHODS: Record<string, true> = {
  eth_chainId: true,
  eth_blockNumber: true,
  eth_getBlockByNumber: true,
  eth_call: true,
  eth_getBalance: true,
  eth_getTransactionReceipt: true,
  eth_getTransactionByHash: true,
  eth_estimateGas: true,
  eth_gasPrice: true,
  eth_maxPriorityFeePerGas: true,
  eth_getCode: true,
};

/** JSON-RPC "method not found": the method is simply not on the read allow-list. */
export const RPC_ERR_NOT_PERMITTED = -32601;
/** Implementation-defined: the method writes or signs and may never be proxied, whatever the list says. */
export const RPC_ERR_WRITE_DENIED = -32001;

// Refused by name rather than by omission, so the error explains itself. `eth_sign*` covers
// `eth_sign` and every `eth_signTypedData*`; `personal_*` covers `personal_sign` and the unlock calls.
const DENIED_EXACT: Record<string, true> = {
  eth_sendTransaction: true, eth_sendRawTransaction: true, eth_accounts: true, eth_requestAccounts: true,
};
const DENIED_PREFIXES = ['eth_sign', 'personal_'] as const;

interface RpcCall { jsonrpc?: string; id?: unknown; method?: string; params?: unknown }

export async function rpcRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  if (deps.chain.mode !== 'robinhood') return;
  const upstream = deps.config.chain.rpcUrl;

  app.post('/rpc', async (request, reply) => {
    const body = request.body as RpcCall | RpcCall[] | null;
    const calls = Array.isArray(body) ? body : [body];
    // One bad member rejects the whole batch: a batch is forwarded as one request, so there is no way
    // to drop a single denied call from it after the fact.
    for (const call of calls) {
      const method = call?.method;
      if (typeof method !== 'string' || RPC_ALLOWED_METHODS[method] !== true) {
        const writesOrSigns = typeof method === 'string'
          && (DENIED_EXACT[method] === true || DENIED_PREFIXES.some((prefix) => method.startsWith(prefix)));
        return reply.status(400).send({
          jsonrpc: '2.0',
          id: call?.id ?? null,
          error: writesOrSigns
            ? { code: RPC_ERR_WRITE_DENIED, message: `RPC method writes or signs and is never proxied: ${method}` }
            : { code: RPC_ERR_NOT_PERMITTED, message: `RPC method not permitted through this proxy: ${String(method)}` },
        });
      }
    }
    let res: Response;
    try {
      res = await fetch(upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return reply.status(502).send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'upstream RPC unreachable' } });
    }
    const text = await res.text();
    try {
      return reply.status(res.status).send(JSON.parse(text));
    } catch {
      return reply.status(502).send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'bad upstream RPC response' } });
    }
  });
}

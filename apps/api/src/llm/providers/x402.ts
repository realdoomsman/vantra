// x402 provider (SPEC-V2 crypto-native inference). Each agent pays the LLM gateway PER CALL from its
// OWN custodied Robinhood Chain wallet using the x402 protocol: the gateway answers the first request
// with `402 Payment Required`, the client signs a USDC payment authorization (EIP-712 typed data,
// EIP-3009 `transferWithAuthorization`) with the agent's key, retries with `PAYMENT-SIGNATURE`, and
// the settlement lands in `PAYMENT-RESPONSE`. There is no provider API key — authentication IS
// payment. The gateway is an OpenAI-compatible Chat Completions endpoint, so the OpenAI SDK drives
// the request and a payment-aware `fetch` settles the 402 out of band.
//
// The real USDC leaves the agent's wallet during the call, but the agent only SIGNS the transfer
// authorization — the facilitator broadcasts it and pays the gas, so the agent needs no ETH and this
// provider never touches an RPC. The step books the call as `inference_paid` — already settled, never
// swept — using the on-chain receipt for the amount and the settlement tx hash. A `withinPriceCap`
// policy caps a single payment so a gateway that quotes an absurd price can never drain a wallet.
//
// The deterministic half — the price cap, the receipt decode and the cost/usage mapping — is pinned by
// test/llm/x402.test.ts. The 402 -> pay -> retry loop itself was driven end to end against a local
// mock gateway (two requests, the EIP-712 authorization recovering to the agent's own address, an
// over-cap quote signed by nobody). A live payment additionally needs a funded Robinhood Chain wallet
// and a running x402 LLM gateway — the one step this machine cannot run itself.
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import type { ClientEvmSigner } from '@x402/evm';
import OpenAI from 'openai';
import type { ModelInfo } from '@vantra/shared';
import type { SettleResponse } from '@x402/core/types';
import type { LlmProvider, LlmResponse } from '../../core/interfaces.js';
import { errorMessage } from '../../lib/errors.js';
import type { Logger } from '../../lib/log.js';
import { LlmCallError } from '../errors.js';
import { requestTimeoutMs } from '../timeout.js';
import { buildChatRequest, mapChatResponse } from './chat.js';

// Resolves the payment signer for one agent. Deliberately NOT a viem `PrivateKeyAccount`: a local
// account closes over the plaintext private key as an immutable JS string, which cannot be zeroed and
// would then live for the whole inference round (up to the 300s request ceiling) where any heap or
// core dump could read it. These wallets hold real USDC. Instead the resolver hands back the minimum
// x402 needs — the agent's stored wallet address plus a `signTypedData` that decrypts the key inside
// `withAgentSecret`, derives an account, signs, and lets both go out of scope on return. The address
// comes from the agent's wallet column, never from deriving the key, so resolving costs no decrypt at
// all: one decrypt per signature, bounded by the zeroed buffer. Do NOT "simplify" this back into a
// long-lived account, and do not memoise the derived account inside the resolver.
//
// `ClientEvmSigner` also declares optional `readContract` / `signTransaction` / `getTransactionCount`
// / `estimateFeesPerGas` members, which x402 uses only for Permit2 and ERC-20 approval sponsoring.
// The gateway path here is EIP-3009 `transferWithAuthorization`, which needs nothing but the address
// and the typed-data signature, so those stay unimplemented.
export type EvmSignerResolver = (agentId: string) => Promise<ClientEvmSigner>;

export interface X402ProviderOpts {
  gatewayUrl: string;           // OpenAI-compatible base URL of the x402 LLM gateway
  maxPriceMicro: number;        // hard cap on a single 402 payment (micro-USD)
  resolveSigner: EvmSignerResolver;
  log: Logger;
  fetchImpl?: typeof fetch;
}

const PAYMENT_RESPONSE_HEADER = 'payment-response';
// The gateway speaks whatever EVM chain its 402 challenge declares; a wildcard registration lets the
// same build serve Robinhood Chain mainnet and testnet without a second config knob.
const EIP155_ANY = 'eip155:*';

export function createX402Provider(opts: X402ProviderOpts): LlmProvider {
  const baseFetch = opts.fetchImpl ?? fetch;
  return {
    // The gateway fans out to arbitrary upstreams, so the request is built in the OpenRouter dialect
    // (`max_tokens` is the only output cap proven to bind through such a gateway — see chat.ts). The
    // real model is kept for pricing and labels.
    name: 'openrouter' satisfies ModelInfo['provider'],
    async complete(req, model): Promise<LlmResponse> {
      const signer = await opts.resolveSigner(req.agentId);
      const client = new x402Client()
        .register(EIP155_ANY, new ExactEvmScheme(signer))
        // Gateways that also accept non-EVM rails list them alongside; we can only settle from this
        // agent's own EVM wallet, so keep only the eip155 requirements or the default selector could
        // pick an option we have no key for.
        .registerPolicy((_v, reqs) => reqs.filter((r) => String(r.network).startsWith('eip155:')))
        // The hard per-payment cap. It is enforced here rather than through `setSpendControls`
        // because the library's dollar cap is resolved against its own DEFAULT_ASSETS table to learn
        // the quoted token's decimals, and that table knows nothing about Robinhood Chain: a dollar
        // cap would reject every quote outright, and `allowedAssets: true` would silently stop
        // capping — one refuses to pay at all, the other quietly stops guarding. Capping in atomic units
        // keeps the guarantee exact for the 6-decimal settlement stablecoin and fails closed for
        // anything else a gateway might quote.
        .registerPolicy((_v, reqs) => reqs.filter((r) => withinPriceCap(r.amount, opts.maxPriceMicro)))
        .setSpendControls(false);

      const paidFetch = wrapFetchWithPayment(baseFetch, client);
      const captured: { settle?: SettleResponse } = {};
      const fetchAndCapture: typeof fetch = async (input, init) => {
        const res = await paidFetch(input, init);
        const header = res.headers.get(PAYMENT_RESPONSE_HEADER);
        if (header) {
          try { captured.settle = decodePaymentResponseHeader(header); }
          catch (e) { opts.log.warn({ agentId: req.agentId, err: errorMessage(e) }, 'x402 settlement header could not be decoded'); }
        }
        return res;
      };

      const oa = new OpenAI({ baseURL: opts.gatewayUrl, apiKey: 'x402', fetch: fetchAndCapture, maxRetries: 0 });
      const params = buildChatRequest(req, { ...model, provider: 'openrouter' });
      let completion: OpenAI.Chat.Completions.ChatCompletion;
      try {
        completion = await oa.chat.completions.create(params, { signal: req.signal, timeout: requestTimeoutMs(req.remainingMs) });
      } catch (e) {
        throw toX402CallError(e);
      }

      const res = mapChatResponse(completion, model, { costFromUsage: true, providerName: 'openrouter' });
      const settle = captured.settle;
      if (settle?.success) applyPaymentReceipt(res, settle);
      // x402 mode expects every call to settle a payment. No receipt means the gateway did not charge
      // (misconfigured or a free tier); fall back to the token estimate and say so.
      else opts.log.warn({ agentId: req.agentId, model: model.id }, 'x402 call returned no payment receipt; billing from token usage');
      return res;
    },
  };
}

// Applies an on-chain settlement receipt to a mapped response: records the payment for the ledger and,
// when the receipt names the amount, makes it authoritative over the token-based estimate.
// `settle.transaction` is the EVM settlement tx hash; the ledger field it lands in stays `txSig`.
export function applyPaymentReceipt(res: LlmResponse, settle: SettleResponse): void {
  const paidMicro = amountMicroOf(settle);
  res.payment = {
    txSig: settle.transaction,
    network: String(settle.network),
    payTo: null,                                  // the recipient is not carried in the settle receipt
    amountMicro: paidMicro ?? res.usage.costMicro,
  };
  if (paidMicro !== null) res.usage.costMicro = paidMicro;
}

// USDC settles in atomic units of 1e-6 (6 decimals), which is exactly one micro-dollar, so the atomic
// amount maps 1:1 to Micro. `amount` is present for `upto`; for `exact` the receipt may omit it and we
// fall back to the metered token cost.
export function amountMicroOf(settle: Pick<SettleResponse, 'amount'>): number | null {
  if (typeof settle.amount !== 'string' || settle.amount.length === 0) return null;
  const n = Number(settle.amount);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// X402_MAX_PRICE_USD as a hard cap on ONE payment. A quote is an atomic (base-unit) integer string of
// the asset the gateway wants; the settlement stablecoin has 6 decimals, so one atomic unit is exactly
// one micro-dollar and the cap compares directly against `maxPriceMicro`. Anything that is not a plain
// non-negative integer — empty, fractional, negative, `1e9`, hex, or absent — is refused rather than
// coerced: an unreadable quote is the case where a wallet gets drained, so it fails closed. BigInt,
// because a hostile gateway can quote a number far past Number.MAX_SAFE_INTEGER.
export function withinPriceCap(amount: string | undefined, maxPriceMicro: number): boolean {
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return false;
  return BigInt(amount) <= BigInt(Math.floor(maxPriceMicro));
}

function toX402CallError(e: unknown): LlmCallError {
  if (e instanceof LlmCallError) return e;
  const msg = errorMessage(e);
  // Transport failures are worth another attempt; a spend-control rejection or a signing failure is not.
  const retryable = /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network|fetch failed|\b(429|500|502|503|504)\b/i.test(msg);
  return new LlmCallError('openrouter', `x402 gateway call failed: ${msg}`, { retryable });
}

// Verification of user-submitted USDC transactions: bounty escrow (SPEC §8.15 POST /api/market/bounties),
// service payments (POST /svc/:id, §8.9) and owner recapitalization (AMENDMENTS C25).
// Callers must ALSO guarantee single use of a transaction hash (service_calls.payment_tx /
// bounties.escrow_tx / deposits_seen.sig are unique) — this only proves what the transaction did.
import { fmtUsd, sameAddress, type Micro } from '@vantra/shared';
import type { ChainAdapter, UsdcTransfer } from '../core/interfaces.js';
import { ApiError } from '../lib/errors.js';

export interface VerifyUsdcOpts {
  to: string;              // wallet that must have been credited
  minAmount: Micro;        // transfer must move at least this much USDC
  from?: string | null;    // wallet that must have sent it (null/undefined = any sender)
  what?: string;           // noun used in error messages, e.g. 'escrow transfer'
}

export const invalidTx = (message: string): ApiError => new ApiError(400, 'INVALID_TX', message);

// Resolves to the transfer when it matches, throws ApiError(400, INVALID_TX) otherwise.
// Addresses are compared case-insensitively: a hash pasted from a block explorer carries EIP-55
// checksumming that a hand-typed or lowercased wallet does not, and the two are the same account.
export async function verifyUsdcTransfer(chain: ChainAdapter, sig: string, opts: VerifyUsdcOpts): Promise<UsdcTransfer> {
  const what = opts.what ?? 'payment';
  const signature = typeof sig === 'string' ? sig.trim() : '';
  if (signature === '') throw invalidTx(`The ${what} transaction hash is missing`);

  const tx = await chain.getUsdcTransfer(signature);
  if (!tx) throw invalidTx(`No confirmed USDC transfer found for ${what} ${shortSig(signature)}`);
  if (!sameAddress(tx.to, opts.to)) {
    throw invalidTx(`The ${what} credited ${shortAddr(tx.to)}, expected ${shortAddr(opts.to)}`);
  }
  if (opts.from && !sameAddress(tx.from, opts.from)) {
    throw invalidTx(`The ${what} was sent by ${shortAddr(tx.from)}, expected ${shortAddr(opts.from)}`);
  }
  if (tx.amount < opts.minAmount) {
    throw invalidTx(`The ${what} moved ${fmtUsd(tx.amount)}, at least ${fmtUsd(opts.minAmount)} is required`);
  }
  return tx;
}

// `0x1234…cdef` for an address, `0x123456…` for a 32-byte hash: enough to recognise, short enough to read.
export const shortAddr = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
export const shortSig = (s: string): string => (s.length > 16 ? `${s.slice(0, 10)}…` : s);

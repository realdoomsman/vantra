// Pure helpers over EVM receipt logs: ERC-20 Transfer events, resolved to the wallets on either side.
// No network access; unit-tested with fixtures. On EVM a token movement IS a log, so there is no
// instruction tree to walk and no per-holder indirection to resolve back to an owner, and a mint
// shows up as an ordinary Transfer from the zero address.
import { getAddress } from 'viem';
import { sameAddress, type Micro } from '@vantra/shared';

export const USDC_DECIMALS = 6;

// keccak256('Transfer(address,address,uint256)') — the ERC-20 topic every token shares.
export const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// The shape of a viem log this module needs; declared structurally so parse.ts stays free of clients.
export interface EvmLog {
  address: string;
  topics: readonly string[];
  data: string;
  logIndex?: number | null;
  transactionHash?: string | null;
}

export interface TokenTransfer {
  token: string;         // the ERC-20 contract that emitted the event (EIP-55)
  from: string;          // sender (EIP-55); the zero address for a mint
  to: string;            // recipient (EIP-55)
  amount: number;        // base units
  logIndex: number;      // position in the block/receipt, so two identical legs stay distinguishable
  txHash: string | null;
}

// An indexed address topic is a 32-byte word: 12 zero bytes then the 20 address bytes.
function topicAddress(topic: string | undefined): string | null {
  if (typeof topic !== 'string' || topic.length !== 66) return null;
  try {
    return getAddress(`0x${topic.slice(26)}`);
  } catch {
    return null;
  }
}

// Base units as a Number. A value past Number.MAX_SAFE_INTEGER is dropped rather than rounded: the
// whole economy is integer micro-USDC, and a silently rounded amount is worse than a missing one.
// At 6 decimals the ceiling is ~9 billion USDC, so this only ever fires on a junk or non-USDC token.
function amountOf(data: string): number | null {
  if (typeof data !== 'string' || !data.startsWith('0x') || data.length < 3) return null;
  let raw: bigint;
  try {
    raw = BigInt(data.length > 66 ? `0x${data.slice(2, 66)}` : data);
  } catch {
    return null;
  }
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

// Every ERC-20 Transfer in the log set, in the order the chain emitted them.
export function extractTokenTransfers(logs: readonly EvmLog[]): TokenTransfer[] {
  const out: TokenTransfer[] = [];
  for (const [index, log] of logs.entries()) {
    if (!log || log.topics?.length !== 3 || !sameAddress(log.topics[0] ?? '', TRANSFER_TOPIC0)) continue;
    const from = topicAddress(log.topics[1]);
    const to = topicAddress(log.topics[2]);
    const amount = amountOf(log.data);
    if (from === null || to === null || amount === null) continue;
    let token: string;
    try {
      token = getAddress(log.address);
    } catch {
      continue;
    }
    out.push({ token, from, to, amount, logIndex: log.logIndex ?? index, txHash: log.transactionHash ?? null });
  }
  return out;
}

// Transfers of `usdcAddress` credited to `address`.
export function usdcInflowsTo(logs: readonly EvmLog[], address: string, usdcAddress: string): TokenTransfer[] {
  return extractTokenTransfers(logs).filter((t) => sameAddress(t.to, address) && sameAddress(t.token, usdcAddress));
}

export interface ResolvedInflow { from: string; amount: Micro; senders: string[] }

/**
 * Collapses every USDC leg of ONE transaction into the single inflow the rest of the system sees.
 *
 * It has to be one row per transaction: runtime/deposits.ts dedupes on `deposits_seen.sig`, so a
 * second row carrying the same hash would be dropped by the conflict clause with its money
 * uncredited. The amount is therefore the sum of all legs — which is what actually arrived — and
 * `from` names one of possibly several senders.
 *
 * It names the sender of the LARGEST leg, not the first the RPC happened to return. `from` becomes
 * `refundTo` on an underpaid purchase (payments/poller.ts), so with first-wins anyone could attach a
 * 1-micro leg to someone else's $100 deposit and have the entire refund redirected to themselves.
 * `senders` is returned so the caller can say out loud that the choice was ambiguous.
 */
export function resolveInflow(parts: readonly TokenTransfer[]): ResolvedInflow | null {
  if (parts.length === 0) return null;
  const largest = parts.reduce((a, b) => (b.amount > a.amount ? b : a));
  return {
    from: largest.from,
    amount: parts.reduce((sum, p) => sum + p.amount, 0),
    senders: [...new Set(parts.map((p) => p.from))],
  };
}

export interface UsdcTransferSummary { from: string; to: string; amount: Micro }

// The largest USDC transfer in the receipt — the one a user-submitted payment/escrow hash is about.
export function largestUsdcTransfer(logs: readonly EvmLog[], usdcAddress: string): UsdcTransferSummary | null {
  const usdc = extractTokenTransfers(logs).filter((t) => sameAddress(t.token, usdcAddress));
  if (usdc.length === 0) return null;
  const best = usdc.reduce((a, b) => (b.amount > a.amount ? b : a));
  return { from: best.from, to: best.to, amount: best.amount };
}

// Block timestamps are unix seconds, and viem hands them over as bigint.
export const blockTimeToDate = (blockTime: bigint | number | null | undefined): Date =>
  new Date(Number(blockTime ?? 0) * 1000);

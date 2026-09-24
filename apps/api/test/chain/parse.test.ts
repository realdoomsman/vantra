import { describe, expect, it } from 'vitest';
import {
  TRANSFER_TOPIC0, blockTimeToDate, extractTokenTransfers, largestUsdcTransfer, resolveInflow,
  usdcInflowsTo, type EvmLog, type TokenTransfer,
} from '../../src/chain/parse.js';

const USDC = '0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const ZERO = '0x0000000000000000000000000000000000000000';

const buyer = '0x1111111111111111111111111111111111111111';
const agent = '0x2222222222222222222222222222222222222222';
const other = '0x3333333333333333333333333333333333333333';

const topicOf = (addr: string): string => `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}`;
const word = (value: bigint): string => `0x${value.toString(16).padStart(64, '0')}`;

let nextIndex = 0;
function transferLog(token: string, from: string, to: string, amount: bigint, txHash = '0xaa'.padEnd(66, 'a')): EvmLog {
  return {
    address: token.toLowerCase(),
    topics: [TRANSFER_TOPIC0, topicOf(from), topicOf(to)],
    data: word(amount),
    logIndex: nextIndex++,
    transactionHash: txHash,
  };
}

describe('chain/parse', () => {
  it('extracts an ERC-20 Transfer and reports both sides EIP-55 checksummed', () => {
    const [t, ...rest] = extractTokenTransfers([transferLog(USDC, buyer, agent, 2_500_000n)]);
    expect(rest).toEqual([]);
    expect(t).toMatchObject({ token: USDC, from: buyer, to: agent, amount: 2_500_000 });
  });

  // A mint is a Transfer from the zero address; the Solana adapter had a separate `mintTo` branch and
  // this is what replaces it.
  it('treats a mint from the zero address as an inflow', () => {
    const [t] = extractTokenTransfers([transferLog(USDC, ZERO, agent, 7_000_000n)]);
    expect(t).toMatchObject({ from: ZERO, to: agent, amount: 7_000_000 });
  });

  it('ignores anything that is not a two-party ERC-20 Transfer', () => {
    const approval: EvmLog = {
      address: USDC,
      topics: ['0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925', topicOf(buyer), topicOf(agent)],
      data: word(1n),
    };
    const shortTopics: EvmLog = { address: USDC, topics: [TRANSFER_TOPIC0, topicOf(buyer)], data: word(1n) };
    const emptyData: EvmLog = { address: USDC, topics: [TRANSFER_TOPIC0, topicOf(buyer), topicOf(agent)], data: '0x' };
    expect(extractTokenTransfers([approval, shortTopics, emptyData])).toEqual([]);
  });

  // The economy is integer micro-USDC end to end. An amount past Number.MAX_SAFE_INTEGER cannot be
  // represented, and a silently rounded one is worse than a missing one.
  it('drops a transfer whose amount cannot be represented exactly', () => {
    expect(extractTokenTransfers([transferLog(USDG, buyer, agent, 2n ** 80n)])).toEqual([]);
  });

  it('filters inflows to one recipient and one token, whatever the spelling', () => {
    const logs = [
      transferLog(USDC, buyer, agent, 1_000_000n),
      transferLog(USDC, agent, buyer, 9n),
      transferLog(USDG, buyer, agent, 5_000_000n),
    ];
    expect(usdcInflowsTo(logs, agent.toLowerCase(), USDC.toUpperCase().replace('0X', '0x')).map((t) => t.amount)).toEqual([1_000_000]);
    expect(usdcInflowsTo(logs, agent, USDG).map((t) => t.amount)).toEqual([5_000_000]);
    expect(usdcInflowsTo(logs, buyer, USDC).map((t) => t.amount)).toEqual([9]);
  });

  it('picks the largest USDC transfer and ignores other tokens', () => {
    const logs = [
      transferLog(USDC, buyer, agent, 250_000n),
      transferLog(USDC, buyer, agent, 4_000_000n),
      transferLog(USDG, buyer, agent, 99_999_999n),
    ];
    expect(largestUsdcTransfer(logs, USDC)).toEqual({ from: buyer, to: agent, amount: 4_000_000 });
    expect(largestUsdcTransfer([], USDC)).toBeNull();
  });

  it('converts block timestamps, treating a missing one as the epoch', () => {
    expect(blockTimeToDate(1_760_000_000n).toISOString()).toBe('2025-10-09T08:53:20.000Z');
    expect(blockTimeToDate(null).getTime()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveInflow: one transaction → the single row the deposit tables can hold.
//
// deposits_seen is keyed by transaction hash, so a transaction carrying USDC legs from two different
// senders cannot become two rows: the second would hit the conflict clause and its money would never
// be credited. It collapses to one row, and the only real question is WHICH sender the row names —
// because payments/poller.ts turns that name into `refundTo` on an underpaid purchase.
// ---------------------------------------------------------------------------
describe('chain/parse resolveInflow', () => {
  const leg = (from: string, amount: number): TokenTransfer =>
    ({ token: USDC, from, to: agent, amount, logIndex: 0, txHash: null });

  it('is null when nothing credited the address', () => {
    expect(resolveInflow([])).toBeNull();
  });

  it('passes a single leg straight through', () => {
    expect(resolveInflow([leg(buyer, 25_000_000)])).toEqual({ from: buyer, amount: 25_000_000, senders: [buyer] });
  });

  it('sums every leg from one sender and still reports one sender', () => {
    const r = resolveInflow([leg(buyer, 10_000_000), leg(buyer, 15_000_000)])!;
    expect(r.amount).toBe(25_000_000);
    expect(r.senders).toEqual([buyer]);
  });

  // The attack this closes: attach a 1-micro leg to someone else's deposit transaction and, under the
  // old first-leg-wins rule, the entire refund of their $100 is redirected to you.
  it('names the LARGEST leg, so a dust leg cannot capture the refund of a big one', () => {
    const first = resolveInflow([leg(other, 1), leg(buyer, 100_000_000)])!;
    expect(first.from).toBe(buyer);
    expect(first.amount).toBe(100_000_001);
    // …and the same however the RPC happened to order them.
    expect(resolveInflow([leg(buyer, 100_000_000), leg(other, 1)])!.from).toBe(buyer);
  });

  it('reports every distinct sender so the caller can say the choice was ambiguous', () => {
    const r = resolveInflow([leg(buyer, 5), leg(other, 7), leg(buyer, 3)])!;
    expect(r.senders).toHaveLength(2);
    expect(new Set(r.senders)).toEqual(new Set([buyer, other]));
    expect(r.amount).toBe(15);
  });
});

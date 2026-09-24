// Autonomous trading (economy/trading.ts): a buy converts liquid USDC into a marked-to-market position,
// a sell realizes P&L back into the treasury, and every guardrail (allowlist, position cap, liquid
// reserve, gas) is enforced server-side. Runs on the memory chain with a settable token price.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeTrade, openPositions } from '../../src/economy/trading.js';
import { positions } from '../../src/db/schema.js';
import { createHarness, type Harness } from './helpers/harness.js';

// An allowlisted ERC-20 on Robinhood Chain (USDG's address, standing in for any tradeable token) —
// EIP-55 exactly as `resolveMint` normalises it, so the memory chain's price fixture keys match.
const TOKEN = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const OFF_ALLOWLIST = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';

describe('economy/trading', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness({ env: {
      TRADE_ENABLED: '1', TRADE_ALLOWED_MINTS: TOKEN,
      TRADE_MAX_POSITION_USD: '5', TRADE_MAX_DAILY_LOSS_USD: '5',
      TRADE_MIN_RESERVE_USD: '2', TRADE_SLIPPAGE_BPS: '150',
    } });
    h.chain.setTokenPrice(TOKEN, 100);   // $100 per token
  });
  afterEach(async () => { await h.close(); });

  // Liquid treasury == on-chain USDC, plus a little ETH for gas.
  const seed = async (treasuryMicro = 10_000_000) => {
    const a = await h.seedAgent({ treasuryMicro, fund: treasuryMicro });
    await h.chain.faucetEth(a.walletPubkey, 10_000_000);
    return a;
  };

  it('buys a token, opens a position, and reduces liquid treasury', async () => {
    const a = await seed();
    const r = await executeTrade(h.deps, { agentId: a.id, action: 'buy', token: TOKEN, amountUsd: 3 });
    expect(r.ok).toBe(true);
    const [pos] = await h.db.select().from(positions).where(eq(positions.agentId, a.id));
    expect(pos!.costMicro).toBe(3_000_000);
    expect(pos!.tokenAmount).toBe(30_000);
    expect((await h.reload(a.id)).treasuryMicro).toBe(7_000_000);
  });

  // The model may type an address in any case; it must still land on the one position row.
  it('accepts a lowercased address as the same token', async () => {
    const a = await seed();
    await executeTrade(h.deps, { agentId: a.id, action: 'buy', token: TOKEN.toLowerCase(), amountUsd: 3 });
    const rows = await h.db.select().from(positions).where(eq(positions.agentId, a.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mint).toBe(TOKEN);
  });

  it('marks the position to market for unrealized P&L', async () => {
    const a = await seed();
    await executeTrade(h.deps, { agentId: a.id, action: 'buy', token: TOKEN, amountUsd: 3 });
    h.chain.setTokenPrice(TOKEN, 150);   // +50%
    const [open] = await openPositions(h.deps, a.id);
    expect(open!.valueMicro).toBe(4_500_000);
    expect(open!.unrealizedMicro).toBe(1_500_000);
  });

  it('realizes profit on a winning sell and closes the position', async () => {
    const a = await seed();
    await executeTrade(h.deps, { agentId: a.id, action: 'buy', token: TOKEN, amountUsd: 3 });
    h.chain.setTokenPrice(TOKEN, 150);
    const r = await executeTrade(h.deps, { agentId: a.id, action: 'sell', token: TOKEN, amountUsd: null });
    expect(r.ok).toBe(true);
    const agent = await h.reload(a.id);
    expect(agent.tradeRealizedMicro).toBe(1_500_000);
    expect(agent.treasuryMicro).toBe(11_500_000);       // 7 + 4.5
    expect(await h.db.select().from(positions).where(eq(positions.agentId, a.id))).toHaveLength(0);
  });

  it('realizes a loss when the price falls', async () => {
    const a = await seed();
    await executeTrade(h.deps, { agentId: a.id, action: 'buy', token: TOKEN, amountUsd: 3 });
    h.chain.setTokenPrice(TOKEN, 50);    // -50%
    await executeTrade(h.deps, { agentId: a.id, action: 'sell', token: TOKEN, amountUsd: null });
    expect((await h.reload(a.id)).tradeRealizedMicro).toBe(-1_500_000);
  });

  it('refuses a token that is not allowlisted', async () => {
    const a = await seed();
    const r = await executeTrade(h.deps, { agentId: a.id, action: 'buy', token: OFF_ALLOWLIST, amountUsd: 3 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/allowlist/i);
  });

  it('refuses to breach the liquid reserve', async () => {
    const a = await seed(3_000_000);   // $3 liquid, $2 reserve
    const r = await executeTrade(h.deps, { agentId: a.id, action: 'buy', token: TOKEN, amountUsd: 2 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/reserve/i);
  });

  it('caps a single position', async () => {
    const a = await seed();
    const r = await executeTrade(h.deps, { agentId: a.id, action: 'buy', token: TOKEN, amountUsd: 6 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/cap/i);
  });

  it('needs ETH for gas', async () => {
    const a = await h.seedAgent({ treasuryMicro: 10_000_000, fund: 10_000_000 });   // no gas ETH
    const r = await executeTrade(h.deps, { agentId: a.id, action: 'buy', token: TOKEN, amountUsd: 3 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/ETH for gas/i);
  });
});

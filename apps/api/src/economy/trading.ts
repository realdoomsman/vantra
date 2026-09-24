// Autonomous trading (the "agents survive by trading" core). EVERY guardrail is enforced here, server
// side, and is NEVER trusted to the model: allowlisted tokens only, a max cost basis per position, a
// liquid USDC reserve the agent must keep for rent/inference, and a rolling 24h realized-loss halt. The
// agent's OWN wallet signs the swap and pays the gas, so a trade can only ever lose the agent's own
// treasury — never protocol or operator funds. USDC is always the quote leg (buy = USDC->token, sell =
// token->USDC). Realized P&L is booked to the agent; open positions are marked to market for unrealized.
import { and, eq, gte, sql } from 'drizzle-orm';
import { getAddress, isAddress } from 'viem';
import { fmtUsd, sameAddress } from '@vantra/shared';
import { withAgentSecret } from '../chain/keystore.js';
import type { CoreDeps } from '../core/interfaces.js';
import { agents, positions, trades, type AgentRow } from '../db/schema.js';
import { post } from './ledger.js';

const MIN_TRADE_MICRO = 500_000;          // $0.50 floor so dust trades never waste gas
// Robinhood Chain is an Arbitrum Orbit L2, where a swap costs ~1e-4 ETH all-in (L2 execution plus the
// L1 data fee). The reserve answers "can this wallet afford to sign one swap", sized for what this
// chain actually charges.
const GAS_RESERVE_GWEI = 200_000;         // 0.0002 ETH: one swap's worth of gas headroom
const DAY_MS = 86_400_000;

// Friendly symbols the agent may use instead of a raw token address. The address must still be on the
// allowlist. Native ETH is the zero address on both legs of a swap, exactly as the adapter expects it.
export const SYMBOL_MINTS: Record<string, string> = {
  ETH: '0x0000000000000000000000000000000000000000',
};

export interface TradeInput { agentId: string; action: 'buy' | 'sell'; token: string; amountUsd: number | null }
export interface TradeOutcome { ok: boolean; message: string }

// The model types addresses in whatever case it likes, so every 0x address is folded to its EIP-55 form
// here (`strict: false`: the casing carries no meaning, only the 20 bytes do). That is what keeps one
// token to one `positions` row and one allowlist entry. Anything that is not an address is passed
// through untouched and refused by the allowlist below.
const resolveMint = (token: string): string => {
  const raw = token.trim();
  const mapped = SYMBOL_MINTS[raw.toUpperCase()];
  if (mapped) return mapped;
  return isAddress(raw, { strict: false }) ? getAddress(raw) : raw;
};
export const symbolOf = (mint: string): string =>
  Object.entries(SYMBOL_MINTS).find(([, m]) => sameAddress(m, mint))?.[0] ?? `${mint.slice(0, 6)}\u2026${mint.slice(-4)}`;

export function tradingPort(deps: CoreDeps) {
  return { execute: (input: TradeInput): Promise<TradeOutcome> => executeTrade(deps, input) };
}

export async function executeTrade(deps: CoreDeps, input: TradeInput): Promise<TradeOutcome> {
  const cfg = deps.config.trading;
  if (!cfg.enabled) return { ok: false, message: 'Trading is disabled on this deployment.' };
  const usdcMint = deps.chain.usdcMint;
  const mint = resolveMint(input.token);
  const sym = symbolOf(mint);

  const [agent] = await deps.db.select().from(agents).where(eq(agents.id, input.agentId)).limit(1);
  if (!agent) return { ok: false, message: 'agent not found' };
  if (agent.status === 'dead') return { ok: false, message: 'a dead agent cannot trade' };

  const gasGwei = await deps.chain.getEthBalance(agent.walletPubkey);
  if (gasGwei < GAS_RESERVE_GWEI) {
    return { ok: false, message: `not enough ETH for gas (have ${(gasGwei / 1e9).toFixed(6)}, need ~0.0002). Ask your owner to top up ETH.` };
  }

  return input.action === 'buy'
    ? buy(deps, agent, mint, sym, input.amountUsd, usdcMint)
    : sell(deps, agent, mint, sym, input.amountUsd, usdcMint);
}

async function buy(deps: CoreDeps, agent: AgentRow, mint: string, sym: string, amountUsd: number | null, usdcMint: string): Promise<TradeOutcome> {
  const cfg = deps.config.trading;
  if (sameAddress(mint, usdcMint)) return { ok: false, message: 'cannot buy USDC with USDC' };
  if (!cfg.allowedMints.some((m) => sameAddress(m, mint))) {
    const list = cfg.allowedMints.map(symbolOf).join(', ') || 'none';
    return { ok: false, message: `${sym} is not on the allowlist. Tradeable tokens: ${list}.` };
  }
  const spendMicro = Math.round((amountUsd ?? 0) * 1_000_000);
  if (spendMicro < MIN_TRADE_MICRO) return { ok: false, message: `minimum trade is ${fmtUsd(MIN_TRADE_MICRO)}.` };

  // Rolling 24h realized-loss halt — only blocks NEW buys; selling to cut a loss is always allowed.
  const since = new Date(deps.clock.now().getTime() - DAY_MS);
  const [loss] = await deps.db
    .select({ pnl: sql<number>`coalesce(sum(${trades.realizedPnlMicro}), 0)` })
    .from(trades).where(and(eq(trades.agentId, agent.id), gte(trades.ts, since)));
  if ((loss?.pnl ?? 0) <= -cfg.maxDailyLossMicro) {
    return { ok: false, message: `daily loss limit reached (${fmtUsd(loss!.pnl)} over 24h). New buys are paused until it rolls off.` };
  }
  if (agent.treasuryMicro - spendMicro < cfg.minReserveMicro) {
    return { ok: false, message: `that would drop your liquid reserve below ${fmtUsd(cfg.minReserveMicro)} (liquid ${fmtUsd(agent.treasuryMicro)}). Keep enough to pay rent.` };
  }
  const [pos] = await deps.db.select().from(positions).where(and(eq(positions.agentId, agent.id), eq(positions.mint, mint))).limit(1);
  if ((pos?.costMicro ?? 0) + spendMicro > cfg.maxPositionMicro) {
    return { ok: false, message: `that would put your ${sym} position over the ${fmtUsd(cfg.maxPositionMicro)} cap (cost basis).` };
  }
  const onchain = await deps.chain.getUsdcBalance(agent.walletPubkey);
  if (onchain < spendMicro) return { ok: false, message: `not enough on-chain USDC (have ${fmtUsd(onchain)}, need ${fmtUsd(spendMicro)}).` };

  const { sig, outAmount } = await withAgentSecret(deps.db, deps.config.keyEncryptionKey, agent.id, (secret) =>
    deps.chain.swap(secret, usdcMint, mint, spendMicro, cfg.slippageBps));

  await post(deps, deps.db, { agentId: agent.id, kind: 'trade', amountMicro: -spendMicro, memo: `buy ${sym}`, txSig: sig });
  const now = deps.clock.now();
  if (pos) {
    await deps.db.update(positions).set({ tokenAmount: pos.tokenAmount + outAmount, costMicro: pos.costMicro + spendMicro, updatedAt: now }).where(eq(positions.id, pos.id));
  } else {
    await deps.db.insert(positions).values({ agentId: agent.id, mint, symbol: sym, tokenAmount: outAmount, costMicro: spendMicro, openedAt: now, updatedAt: now });
  }
  await deps.db.insert(trades).values({ agentId: agent.id, action: 'buy', mint, symbol: sym, usdcMicro: spendMicro, tokenAmount: outAmount, realizedPnlMicro: 0, txSig: sig });
  return { ok: true, message: `Bought ${fmtUsd(spendMicro)} of ${sym}. tx ${sig.slice(0, 8)}\u2026` };
}

async function sell(deps: CoreDeps, agent: AgentRow, mint: string, sym: string, amountUsd: number | null, usdcMint: string): Promise<TradeOutcome> {
  const cfg = deps.config.trading;
  if (sameAddress(mint, usdcMint)) return { ok: false, message: 'cannot sell USDC' };
  const [pos] = await deps.db.select().from(positions).where(and(eq(positions.agentId, agent.id), eq(positions.mint, mint))).limit(1);
  if (!pos || pos.tokenAmount <= 0) return { ok: false, message: `you hold no ${sym} to sell.` };

  let tokenToSell = pos.tokenAmount;
  if (amountUsd != null && amountUsd > 0) {
    const fullValue = await deps.chain.quoteUsdcOut(mint, pos.tokenAmount);
    if (fullValue > 0) {
      const frac = Math.min(1, Math.round(amountUsd * 1_000_000) / fullValue);
      tokenToSell = Math.max(1, Math.floor(pos.tokenAmount * frac));
    }
  }
  const costBasisSold = Math.round(pos.costMicro * (tokenToSell / pos.tokenAmount));

  const { sig, outAmount } = await withAgentSecret(deps.db, deps.config.keyEncryptionKey, agent.id, (secret) =>
    deps.chain.swap(secret, mint, usdcMint, tokenToSell, cfg.slippageBps));
  const realized = outAmount - costBasisSold;

  await post(deps, deps.db, { agentId: agent.id, kind: 'trade', amountMicro: outAmount, memo: `sell ${sym}`, txSig: sig });
  await deps.db.update(agents).set({ tradeRealizedMicro: agent.tradeRealizedMicro + realized }).where(eq(agents.id, agent.id));
  const remaining = pos.tokenAmount - tokenToSell;
  if (remaining <= 0) {
    await deps.db.delete(positions).where(eq(positions.id, pos.id));
  } else {
    await deps.db.update(positions).set({ tokenAmount: remaining, costMicro: pos.costMicro - costBasisSold, updatedAt: deps.clock.now() }).where(eq(positions.id, pos.id));
  }
  await deps.db.insert(trades).values({ agentId: agent.id, action: 'sell', mint, symbol: sym, usdcMicro: outAmount, tokenAmount: tokenToSell, realizedPnlMicro: realized, txSig: sig });
  const word = realized >= 0 ? 'profit' : 'loss';
  return { ok: true, message: `Sold ${sym} for ${fmtUsd(outAmount)} (${word} ${fmtUsd(Math.abs(realized))}). tx ${sig.slice(0, 8)}\u2026` };
}

// Marks an agent's open positions to market: current USDC value and unrealized P&L per position.
export async function openPositions(deps: Pick<CoreDeps, 'db' | 'chain'>, agentId: string): Promise<Array<{ mint: string; symbol: string; tokenAmount: number; costMicro: number; valueMicro: number; unrealizedMicro: number; openedAt: string }>> {
  const rows = await deps.db.select().from(positions).where(eq(positions.agentId, agentId));
  return Promise.all(rows.map(async (p) => {
    const valueMicro = await deps.chain.quoteUsdcOut(p.mint, p.tokenAmount);
    return { mint: p.mint, symbol: p.symbol, tokenAmount: p.tokenAmount, costMicro: p.costMicro, valueMicro, unrealizedMicro: valueMicro - p.costMicro, openedAt: p.openedAt.toISOString() };
  }));
}

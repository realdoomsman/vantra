// x402 provider receipt handling and the per-payment price cap: the on-chain settlement decides what
// the agent is billed and what the step records, and no quote above X402_MAX_PRICE_USD may ever be
// signed. The live 402 -> pay -> retry loop needs a funded wallet and a running gateway, so here we
// prove the deterministic half — capping a quote, and turning a settlement receipt into a billed payment.
import { describe, expect, it } from 'vitest';
import type { SettleResponse } from '@x402/core/types';
import type { LlmResponse } from '../../src/core/interfaces.js';
import { amountMicroOf, applyPaymentReceipt, withinPriceCap } from '../../src/llm/providers/x402.js';
import { buildCatalog } from '../../src/llm/catalog.js';

// Settlement ids are 32-byte EVM tx hashes; the field they land in is still named `txSig`.
const TX_A = `0x${'a1'.repeat(32)}`;
const TX_B = `0x${'b2'.repeat(32)}`;
const NETWORK = 'eip155:4663';                 // Robinhood Chain mainnet, CAIP-2

const settle = (over: Partial<SettleResponse>): SettleResponse => ({
  success: true, transaction: TX_A, network: NETWORK, ...over,
} as SettleResponse);

const baseResponse = (costMicro: number): LlmResponse => ({
  content: [{ type: 'text', text: 'ok' }],
  stopReason: 'end_turn',
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costMicro },
  model: 'claude-haiku-4-5',
});

describe('llm/x402 amountMicroOf', () => {
  it('reads an atomic USDC amount as micro-dollars 1:1', () => {
    expect(amountMicroOf({ amount: '1500' })).toBe(1500);   // 0.0015 USDC == 1500 micro-USD
  });
  it('is null when the receipt omits the amount (exact scheme)', () => {
    expect(amountMicroOf({})).toBeNull();
    expect(amountMicroOf({ amount: '' })).toBeNull();
  });
  it('is null for a non-numeric amount rather than billing NaN', () => {
    expect(amountMicroOf({ amount: 'lots' })).toBeNull();
  });
});

describe('llm/x402 withinPriceCap', () => {
  it('admits a quote at the cap and refuses the first unit above it', () => {
    expect(withinPriceCap('2500', 2500)).toBe(true);     // atomic USDC == micro-USD, 1:1
    expect(withinPriceCap('2501', 2500)).toBe(false);
  });
  it('refuses a quote it cannot read as an atomic integer rather than paying it', () => {
    for (const bad of [undefined, '', '2.5', '-1', '1e9', '0x10', 'lots']) {
      expect(withinPriceCap(bad, 1_000_000)).toBe(false);
    }
  });
  it('refuses an absurd quote past Number.MAX_SAFE_INTEGER instead of overflowing to a pass', () => {
    expect(withinPriceCap('9'.repeat(30), 1_000_000)).toBe(false);
  });
});

describe('llm/x402 applyPaymentReceipt', () => {
  it('records the receipt and makes its amount authoritative over the token estimate', () => {
    const res = baseResponse(999);   // token estimate the mapper produced
    applyPaymentReceipt(res, settle({ amount: '2500', transaction: TX_A }));
    expect(res.payment).toEqual({ txSig: TX_A, network: NETWORK, payTo: null, amountMicro: 2500 });
    expect(res.usage.costMicro).toBe(2500);                 // the chain receipt wins
  });

  it('falls back to the token cost when the receipt names no amount', () => {
    const res = baseResponse(777);
    applyPaymentReceipt(res, settle({ amount: undefined, transaction: TX_B }));
    expect(res.payment).toEqual({ txSig: TX_B, network: NETWORK, payTo: null, amountMicro: 777 });
    expect(res.usage.costMicro).toBe(777);                  // unchanged: nothing more authoritative arrived
  });
});

describe('llm/x402 catalog gating', () => {
  const noKeys = { anthropic: false, openai: false, openrouter: false };

  it('serves real models with NO provider keys in x402 mode (payment replaces the key)', () => {
    const { models } = buildCatalog({ mode: 'x402', keys: noKeys, allowed: [] });
    const enabled = models.filter((m) => m.enabled).map((m) => m.id);
    expect(enabled).toContain('claude-haiku-4-5');   // disabled "no ANTHROPIC_API_KEY" under router mode
    expect(enabled).not.toContain('mock-fast');      // mock models stay out unless LLM_PROVIDER=mock
  });

  it('still gates a model on its own key under router mode', () => {
    const { models, disabled } = buildCatalog({ mode: 'router', keys: { anthropic: true, openai: false, openrouter: false }, allowed: [] });
    const enabled = models.filter((m) => m.enabled).map((m) => m.id);
    expect(enabled).toContain('claude-haiku-4-5');      // its ANTHROPIC_API_KEY is present
    expect(enabled).not.toContain('gpt-5-nano');        // no OPENAI_API_KEY
    expect(disabled.get('gpt-5-nano')).toMatch(/OPENAI_API_KEY/);
  });
});

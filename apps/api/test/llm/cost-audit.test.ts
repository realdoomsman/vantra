// Runnable audit of the money maths. Every agent dies when its treasury hits zero and the platform
// pays whatever the agent is not charged, so this file re-derives the cost of a completion from the
// published rate rules with INTEGER arithmetic and checks the shipping code against it — rather than
// asserting that priceUsage agrees with itself.
//
// Rate rules (USD per 1M tokens, relative to the model's base input price):
//   uncached input  1×      cache read      0.1×
//   5-minute write  1.25×   1-hour write    2×        output  the model's own output price
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG, estimateMicro, priceUsage, type ModelInfo } from '@vantra/shared';
import { cheapestOf, ENV_ADDABLE_MODELS } from '../../src/llm/catalog.js';
import { mapAnthropicResponse } from '../../src/llm/providers/anthropic.js';
import { mapChatResponse } from '../../src/llm/providers/chat.js';

const ALL: ModelInfo[] = [...DEFAULT_CATALOG, ...ENV_ADDABLE_MODELS];
const model = (id: string): ModelInfo => ALL.find((m) => m.id === id)!;

// ---- independent re-implementation -----------------------------------------------------------
// USD per 1M tokens → integer micro-USD per 1M tokens, so the whole sum is exact integer maths and
// cannot drift the way `1000 * 0.2 = 200.00000000000003` does.
const rate = (perM: number): number => Math.round(perM * 1_000_000);

interface Split { input: number; read: number; write5m: number; write1h: number; output: number }

function expectedMicro(m: ModelInfo, s: Split): number {
  const base = m.inputPerM;
  const total =
    s.input * rate(base) +
    s.read * rate(m.cacheReadPerM ?? base * 0.1) +
    s.write5m * rate(m.cacheWritePerM ?? base * 1.25) +
    s.write1h * rate(m.cacheWrite1hPerM ?? base * 2) +
    s.output * rate(m.outputPerM);
  return Math.ceil(total / 1_000_000);
}

// Shapes a real step actually produces: a cold first round, a warm later round, a 1h system-prefix
// rewrite, an output-heavy turn, and the degenerate zero.
const SPLITS: [string, Split][] = [
  ['cold first round', { input: 9_000, read: 0, write5m: 0, write1h: 4_200, output: 1_400 }],
  ['warm later round', { input: 900, read: 12_000, write5m: 2_100, write1h: 0, output: 800 }],
  ['system prefix rewritten', { input: 350, read: 0, write5m: 1_100, write1h: 4_200, output: 120 }],
  ['output heavy', { input: 1_000, read: 0, write5m: 0, write1h: 0, output: 16_000 }],
  ['nothing', { input: 0, read: 0, write5m: 0, write1h: 0, output: 0 }],
  ['one token each', { input: 1, read: 1, write5m: 1, write1h: 1, output: 1 }],
];

describe.each(ALL)('priceUsage against an independent implementation: $id', (m) => {
  for (const [label, s] of SPLITS) {
    it(label, () => {
      const usage = {
        inputTokens: s.input,
        outputTokens: s.output,
        cacheReadTokens: s.read,
        cacheWriteTokens: s.write5m + s.write1h,
        cacheWrite1hTokens: s.write1h,
      };
      expect(priceUsage(m, usage)).toBe(expectedMicro(m, s));
    });
  }

  it('estimateMicro prices everything as uncached input plus output', () => {
    expect(estimateMicro(m, 3_000, 600)).toBe(expectedMicro(m, { input: 3_000, read: 0, write5m: 0, write1h: 0, output: 600 }));
  });

  it('never returns a fractional or negative price', () => {
    for (const [, s] of SPLITS) {
      const v = priceUsage(m, { inputTokens: s.input, outputTokens: s.output, cacheReadTokens: s.read, cacheWriteTokens: s.write5m + s.write1h, cacheWrite1hTokens: s.write1h });
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('cache-write TTL pricing', () => {
  const sonnet = model('claude-sonnet-5');   // base input $2/MTok ⇒ 5m write $2.50, 1h write $4.00

  it('charges a 1-hour write at 2x base input and a 5-minute write at 1.25x', () => {
    const write = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 };
    expect(priceUsage(sonnet, { ...write, cacheWrite1hTokens: 0 })).toBe(2_500_000);
    expect(priceUsage(sonnet, { ...write, cacheWrite1hTokens: 1_000_000 })).toBe(4_000_000);
    expect(priceUsage(sonnet, { ...write, cacheWrite1hTokens: 500_000 })).toBe(3_250_000);
  });

  it('treats an omitted 1h count as an all-5-minute write, exactly as before', () => {
    const usage = { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 4_000, cacheWriteTokens: 2_000 };
    expect(priceUsage(sonnet, usage)).toBe(priceUsage(sonnet, { ...usage, cacheWrite1hTokens: 0 }));
  });

  it('clamps a 1h count that exceeds or undercuts the total write', () => {
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000 };
    expect(priceUsage(sonnet, { ...usage, cacheWrite1hTokens: 9_999 })).toBe(priceUsage(sonnet, { ...usage, cacheWrite1hTokens: 1_000 }));
    expect(priceUsage(sonnet, { ...usage, cacheWrite1hTokens: -5 })).toBe(priceUsage(sonnet, { ...usage, cacheWrite1hTokens: 0 }));
  });
});

// ---- provider response → cost ------------------------------------------------------------------

const anthropicMessage = (usage: Record<string, unknown>): Anthropic.Message => ({
  id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
  content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', stop_sequence: null, usage,
}) as unknown as Anthropic.Message;

describe('anthropic response → cost', () => {
  const sonnet = model('claude-sonnet-5');

  // buildAnthropicRequest marks the system prefix `ttl: '1h'`, so a real response splits its cache
  // writes across two rates. Billing the whole write at 1.25x silently under-charges every step.
  it('prices the 1h slice of cache_creation at 2x, not 1.25x', () => {
    const res = mapAnthropicResponse(anthropicMessage({
      input_tokens: 350, output_tokens: 120, cache_read_input_tokens: 0,
      cache_creation_input_tokens: 5_300,
      cache_creation: { ephemeral_1h_input_tokens: 4_200, ephemeral_5m_input_tokens: 1_100 },
    }), sonnet);

    expect(res.usage.cacheWriteTokens).toBe(5_300);
    expect(res.usage.costMicro).toBe(expectedMicro(sonnet, { input: 350, read: 0, write5m: 1_100, write1h: 4_200, output: 120 }));
    // …and it is strictly more than the old all-5-minute maths would have charged.
    expect(res.usage.costMicro).toBeGreaterThan(priceUsage(sonnet, { ...res.usage, cacheWrite1hTokens: 0 }));
  });

  it('falls back to the 5-minute rate only when the API omits the breakdown', () => {
    const res = mapAnthropicResponse(anthropicMessage({
      input_tokens: 350, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 5_300,
    }), sonnet);
    expect(res.usage.costMicro).toBe(expectedMicro(sonnet, { input: 350, read: 0, write5m: 5_300, write1h: 0, output: 120 }));
  });

  // input_tokens on Anthropic is the UNCACHED remainder: total prompt = input + creation + read.
  it('treats input_tokens as the uncached remainder, never double counting cache tokens', () => {
    const res = mapAnthropicResponse(anthropicMessage({
      input_tokens: 900, output_tokens: 800, cache_read_input_tokens: 12_000,
      cache_creation_input_tokens: 2_100, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 2_100 },
    }), sonnet);
    expect(res.usage).toMatchObject({ inputTokens: 900, cacheReadTokens: 12_000, cacheWriteTokens: 2_100 });
    expect(res.usage.costMicro).toBe(expectedMicro(sonnet, { input: 900, read: 12_000, write5m: 2_100, write1h: 0, output: 800 }));
  });
});

const chatCompletion = (over: Record<string, unknown>): OpenAI.Chat.Completions.ChatCompletion => ({
  id: 'chatcmpl-1', object: 'chat.completion', created: 0, model: 'x',
  choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'done', refusal: null } }],
  ...over,
}) as unknown as OpenAI.Chat.Completions.ChatCompletion;

describe('chat completions response → cost', () => {
  const nano = model('gpt-5-nano');
  const kimi = model('moonshotai/kimi-k2');

  // OpenAI's prompt_tokens INCLUDES prompt_tokens_details.cached_tokens. Pricing prompt_tokens at
  // the full input rate AND the cached slice at the cache rate would bill the cached tokens twice.
  it('subtracts cached_tokens out of prompt_tokens instead of double counting them', () => {
    const res = mapChatResponse(chatCompletion({
      usage: { prompt_tokens: 5_000, completion_tokens: 800, total_tokens: 5_800, prompt_tokens_details: { cached_tokens: 3_000 } },
    }), nano, { costFromUsage: false });

    expect(res.usage).toMatchObject({ inputTokens: 2_000, cacheReadTokens: 3_000, cacheWriteTokens: 0, outputTokens: 800 });
    expect(res.usage.inputTokens + res.usage.cacheReadTokens).toBe(5_000);
    expect(res.usage.costMicro).toBe(expectedMicro(nano, { input: 2_000, read: 3_000, write5m: 0, write1h: 0, output: 800 }));
  });

  it('prices the whole prompt as uncached when the provider reports no cached slice', () => {
    const res = mapChatResponse(chatCompletion({ usage: { prompt_tokens: 5_000, completion_tokens: 800, total_tokens: 5_800 } }), nano, { costFromUsage: false });
    expect(res.usage.costMicro).toBe(expectedMicro(nano, { input: 5_000, read: 0, write5m: 0, write1h: 0, output: 800 }));
  });

  // OpenRouter's usage.cost is the amount it actually billed, in USD. It wins over catalog pricing.
  it('takes OpenRouter usage.cost as authoritative and rounds it up to whole micro-dollars', () => {
    for (const [cost, micro] of [[0.001, 1_000], [0.0000004, 1], [1.2345678, 1_234_568], [0, 0]] as const) {
      const res = mapChatResponse(chatCompletion({
        model: kimi.id, usage: { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100, cost },
      }), kimi, { costFromUsage: true });
      expect(res.usage.costMicro).toBe(micro);
    }
  });

  it('prices from the catalog when OpenRouter reports no cost, and ignores a nonsense one', () => {
    const fromCatalog = expectedMicro(kimi, { input: 1_000, read: 0, write5m: 0, write1h: 0, output: 100 });
    for (const usage of [
      { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 },
      { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100, cost: null },
      { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100, cost: 'free' },
      { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100, cost: Number.NaN },
    ]) {
      expect(mapChatResponse(chatCompletion({ model: kimi.id, usage }), kimi, { costFromUsage: true }).usage.costMicro).toBe(fromCatalog);
    }
  });

  // A response with no usage block at all bills the agent nothing; the router logs it loudly because
  // the platform, not the agent, ends up paying for that completion.
  it('records a missing usage block as zero rather than inventing a number', () => {
    const res = mapChatResponse(chatCompletion({}), nano, { costFromUsage: false });
    expect(res.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicro: 0 });
  });
});

// ---- catalog prices ----------------------------------------------------------------------------

describe('catalog prices', () => {
  // Anthropic list prices, USD per 1M tokens. Wrong numbers here mean every agent is mis-billed on
  // every single step, so they are pinned rather than trusted.
  const PUBLISHED: Record<string, [number, number]> = {
    'claude-opus-5': [5, 25],
    'claude-sonnet-5': [2, 10],
    'claude-haiku-4-5': [1, 5],
    'claude-fable-5-1': [10, 50],
    // OpenRouter, read from the live GET /api/v1/models catalogue on 2026-09-18. These are the
    // pre-key floor: with a key, refreshOpenRouterPricing overwrites them at boot and the billed
    // usage.cost wins per completion. test/llm/live-openrouter.test.ts re-checks them against the
    // service itself under VANTRA_LIVE_NET=1; this pin catches an edit with no network.
    'deepseek/deepseek-chat-v3.1': [0.25, 0.95],
    'qwen/qwen3-235b-a22b-2507': [0.0875, 0.35],
    'moonshotai/kimi-k2': [0.57, 2.3],
  };

  for (const [id, [inputPerM, outputPerM]] of Object.entries(PUBLISHED)) {
    it(`${id} is priced at $${inputPerM}/$${outputPerM} per 1M tokens`, () => {
      expect(model(id)).toMatchObject({ inputPerM, outputPerM });
    });
  }

  it('prices every model in the catalog, with nothing left unpinned but the mock and openai brains', () => {
    const unpinned = ALL.filter((m) => !(m.id in PUBLISHED)).map((m) => m.id).sort();
    expect(unpinned).toEqual(['gpt-5-nano', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'mock-fast', 'mock-strong']);
  });

  // Anthropic cache reads are 0.1x base input on every model in the catalog EXCEPT Fable 5.1, which
  // is a published flat $0.25/MTok. Left to the default, Fable's $10 base would bill a cached round
  // at $1.00/MTok — 4x what Anthropic actually charges, taken out of the agent's treasury.
  const ANTHROPIC_CACHE_READ_PER_M: Record<string, number | undefined> = { 'claude-fable-5-1': 0.25 };

  it('prices anthropic cache reads at the published rate, default multiplier or not', () => {
    for (const m of ALL.filter((x) => x.provider === 'anthropic')) {
      const override = ANTHROPIC_CACHE_READ_PER_M[m.id];
      expect(m.cacheReadPerM).toBe(override);
      expect(m.cacheWritePerM).toBeUndefined();
      expect(m.cacheWrite1hPerM).toBeUndefined();
      const expected = Math.round((override ?? m.inputPerM * 0.1) * 1_000_000);
      expect(priceUsage(m, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 })).toBe(expected);
    }
  });

  it('every model costs something to run', () => {
    for (const m of ALL) {
      expect(m.inputPerM).toBeGreaterThan(0);
      expect(m.outputPerM).toBeGreaterThan(0);
      expect(m.outputPerM).toBeGreaterThanOrEqual(m.inputPerM);
    }
  });

  // cheapest() picks the model a dying agent is downgraded to; a wrong answer here kills agents.
  it('cheapest() really is the cheapest enabled model by brute force', () => {
    const enabled = DEFAULT_CATALOG.filter((m) => m.enabled);
    const byCost = [...enabled].sort((a, b) => estimateMicro(a, 3_000, 600) - estimateMicro(b, 3_000, 600) || a.id.localeCompare(b.id));
    expect(cheapestOf(DEFAULT_CATALOG).id).toBe(byCost[0]!.id);
    for (const m of enabled) {
      expect(estimateMicro(cheapestOf(DEFAULT_CATALOG), 3_000, 600)).toBeLessThanOrEqual(estimateMicro(m, 3_000, 600));
    }
  });
});

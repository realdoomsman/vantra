// LIVE check against OpenRouter's real catalogue. This is the one provider whose model list and
// prices are readable WITHOUT an API key, so it is the only place the wire format can be checked
// against the actual service before the founder adds a key.
//
//   VANTRA_LIVE_NET=1 pnpm --filter @vantra/api exec vitest run test/llm/live-openrouter.test.ts
//
// Skipped by default so the offline suite stays hermetic. What it proves:
//   1. every OpenRouter model in DEFAULT_CATALOG still exists upstream (a renamed id is a 404 on
//      the first real call);
//   2. every parameter buildChatRequest puts on the wire is one the model advertises in
//      `supported_parameters` — OpenRouter DROPS what the upstream does not support, so an output
//      cap under the wrong name would silently leave the generation uncapped on the agent's money;
//   3. the catalog's static prices still match the published ones (they are the pre-key floor used
//      by the affordability gate and the buyer-facing runway projection);
//   4. refreshOpenRouterPricing — the shipping boot path — parses the real response.
import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG, type ModelInfo } from '@vantra/shared';
import { buildChatRequest } from '../../src/llm/providers/chat.js';
import { OPENROUTER_MODELS_URL, refreshOpenRouterPricing } from '../../src/llm/catalog.js';
import { makeRequest } from './helpers.js';

const LIVE = process.env['VANTRA_LIVE_NET'] === '1';
const OPENROUTER_MODELS = DEFAULT_CATALOG.filter((m) => m.provider === 'openrouter');

// Sent on every request but never model-specific: OpenRouter's own routing/accounting fields.
const NOT_MODEL_PARAMS = new Set(['model', 'messages', 'usage']);

interface LiveModel { id: string; context_length?: number; supported_parameters?: string[]; pricing?: Record<string, string | number> }

async function fetchLiveModels(): Promise<Map<string, LiveModel>> {
  const res = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${OPENROUTER_MODELS_URL}: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: LiveModel[] };
  return new Map((body.data ?? []).map((m) => [m.id, m]));
}

const perM = (v: string | number | undefined): number | null =>
  v === undefined || v === '' ? null : Math.round(Number(v) * 1e6 * 1e6) / 1e6;

describe.runIf(LIVE)('openrouter, live catalogue', () => {
  let live: Map<string, LiveModel>;

  it('reaches the public model list', async () => {
    live = await fetchLiveModels();
    expect(live.size).toBeGreaterThan(100);
  }, 45_000);

  for (const model of OPENROUTER_MODELS) {
    describe(model.id, () => {
      const upstream = (): LiveModel => {
        const m = live.get(model.id);
        if (!m) throw new Error(`${model.id} is no longer in the OpenRouter catalogue`);
        return m;
      };

      it('still exists upstream', () => {
        expect(upstream().id).toBe(model.id);
      });

      // The whole point of the file: a parameter OpenRouter does not recognise for this model is
      // thrown away, not rejected. An output cap thrown away is an unbounded, unbudgeted generation.
      it('sends only parameters this model advertises', () => {
        const supported = new Set(upstream().supported_parameters ?? []);
        const sent = Object.keys(buildChatRequest(makeRequest({ model: model.id }), model))
          .filter((k) => !NOT_MODEL_PARAMS.has(k));
        expect(sent).toContain('max_tokens');
        for (const key of sent) expect(supported, `${model.id} does not support "${key}"`).toContain(key);
      });

      it('has the catalog price the service publishes', () => {
        const pricing = upstream().pricing ?? {};
        expect(perM(pricing['prompt'])).toBe(model.inputPerM);
        expect(perM(pricing['completion'])).toBe(model.outputPerM);
        const cacheRead = perM(pricing['input_cache_read']);
        if (cacheRead !== null) expect(model.cacheReadPerM).toBe(cacheRead);
      });

      it('has a context window the catalog does not overstate', () => {
        const contextK = Math.floor((upstream().context_length ?? 0) / 1024);
        expect(model.contextK).toBeLessThanOrEqual(contextK);
      });
    });
  }

  it('refreshOpenRouterPricing parses the real response and reprices every served model', async () => {
    const models: ModelInfo[] = DEFAULT_CATALOG.map((m) => ({ ...m }));
    const updated = await refreshOpenRouterPricing(models, 'unused-public-endpoint');
    expect(updated.sort()).toEqual(OPENROUTER_MODELS.map((m) => m.id).sort());
    for (const m of models.filter((x) => x.provider === 'openrouter')) {
      expect(m.inputPerM).toBeGreaterThan(0);
      expect(m.outputPerM).toBeGreaterThan(0);
    }
    // Nothing that is not an OpenRouter model may be touched.
    for (const m of models.filter((x) => x.provider !== 'openrouter')) {
      expect(m).toEqual(DEFAULT_CATALOG.find((d) => d.id === m.id));
    }
  }, 45_000);
});

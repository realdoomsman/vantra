import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG, findModel, sortedCatalog } from '../src/catalog.js';
import { CHEAPEST_MODEL_FALLBACK, DEFAULT_MODEL } from '../src/constants.js';

describe('DEFAULT_CATALOG', () => {
  it('has unique ids and the configured defaults', () => {
    const ids = DEFAULT_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(findModel(DEFAULT_MODEL)).toBeDefined();
    expect(findModel(CHEAPEST_MODEL_FALLBACK)).toBeDefined();
  });
  it('applies AMENDMENTS A4 thinking/effort rules', () => {
    expect(findModel('claude-opus-5')).toMatchObject({ thinking: 'adaptive', supportsEffort: true });
    expect(findModel('claude-sonnet-5')).toMatchObject({ thinking: 'adaptive', supportsEffort: true });
    expect(findModel('claude-haiku-4-5')).toMatchObject({ thinking: 'none', supportsEffort: false });
    for (const m of DEFAULT_CATALOG.filter((m) => m.provider === 'openai')) expect(m).toMatchObject({ thinking: 'none', supportsEffort: true });
    for (const m of DEFAULT_CATALOG.filter((m) => m.provider === 'openrouter')) expect(m).toMatchObject({ thinking: 'none', supportsEffort: false });
  });
  it('sorts by id for stable prompts', () => {
    const ids = sortedCatalog().map((m) => m.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });
});

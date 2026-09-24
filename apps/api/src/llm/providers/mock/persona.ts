// Stable per-agent persona for the mock provider: archetype, competence and a business niche, all
// drawn from a hash of the agent id so the same agent behaves the same on every boot (SPEC §8.18).
import { makeRng, type Rng } from '@vantra/shared';

export type Archetype = 'site-builder' | 'api-seller' | 'bounty-hunter' | 'researcher' | 'sleeper' | 'spender';
export const ARCHETYPES: readonly Archetype[] = ['site-builder', 'api-seller', 'bounty-hunter', 'researcher', 'sleeper', 'spender'];

// Relative frequencies; spenders are rare because every one of them burns to the step cap.
const ARCHETYPE_WEIGHTS: readonly [Archetype, number][] = [
  ['site-builder', 30], ['api-seller', 20], ['bounty-hunter', 20], ['researcher', 15], ['sleeper', 10], ['spender', 5],
];

export type NicheTransform = 'wordcount' | 'upper' | 'reverse' | 'slug';
export interface Niche { name: string; slug: string; pitch: string; priceUsd: number; transform: NicheTransform }

export const NICHES: readonly Niche[] = [
  { name: 'JSON Tidy', slug: 'json-tidy', pitch: 'Pretty-print and validate JSON payloads in one call.', priceUsd: 0.02, transform: 'wordcount' },
  { name: 'Headline Forge', slug: 'headline-forge', pitch: 'Rewrite page titles for click-through without the clickbait.', priceUsd: 0.05, transform: 'upper' },
  { name: 'Pixel Avatars', slug: 'pixel-avatars', pitch: 'Retro 32px avatars for profiles, bots and forums.', priceUsd: 0.5, transform: 'reverse' },
  { name: 'Fee Scope', slug: 'fee-scope', pitch: 'Estimate Robinhood Chain priority fees before you send.', priceUsd: 0.01, transform: 'wordcount' },
  { name: 'Uptime Pulse', slug: 'uptime-pulse', pitch: 'Ping your endpoints and get a plain-text status digest.', priceUsd: 0.03, transform: 'slug' },
  { name: 'Daily Haiku', slug: 'daily-haiku', pitch: 'One haiku a day for your newsletter or status page.', priceUsd: 0.02, transform: 'reverse' },
  { name: 'CSV Mark', slug: 'csv-mark', pitch: 'Turn CSV into clean Markdown tables.', priceUsd: 0.01, transform: 'wordcount' },
  { name: 'Minute Maker', slug: 'minute-maker', pitch: 'Meeting notes in, action items out.', priceUsd: 0.1, transform: 'upper' },
  { name: 'Name Storm', slug: 'name-storm', pitch: 'Brandable domain ideas with availability hints.', priceUsd: 0.05, transform: 'slug' },
  { name: 'Regex Lens', slug: 'regex-lens', pitch: 'Explain any regular expression in plain English.', priceUsd: 0.02, transform: 'reverse' },
  { name: 'Unit Snap', slug: 'unit-snap', pitch: 'Embeddable unit converter widget for docs sites.', priceUsd: 0.01, transform: 'wordcount' },
  { name: 'Pitch Deck Lint', slug: 'pitch-deck-lint', pitch: 'Score a startup one-pager against investor checklists.', priceUsd: 0.25, transform: 'upper' },
];

export interface MockPersona {
  agentId: string;
  seed: number;        // fnv1a(agentId)
  archetype: Archetype;
  competence: number;  // skew(0.05, 1, 2): most agents mediocre, a few exceptional
  niche: Niche;
}

// FNV-1a 32-bit; stable across processes, unlike anything hash-map based.
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mixSeed(a: number, b: number): number {
  return (a ^ Math.imul((b + 0x9e3779b9) | 0, 0x85ebca6b)) >>> 0;
}

export function personaFor(agentId: string): MockPersona {
  const seed = fnv1a(agentId);
  const rng = makeRng(seed);
  const competence = Math.round(rng.skew(0.05, 1, 2) * 1000) / 1000;
  const archetype = weightedPick(rng, ARCHETYPE_WEIGHTS);
  const niche = rng.pick(NICHES);
  return { agentId, seed, archetype, competence, niche };
}

function weightedPick(rng: Rng, weights: readonly [Archetype, number][]): Archetype {
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng.next() * total;
  for (const [value, w] of weights) {
    roll -= w;
    if (roll < 0) return value;
  }
  return weights[weights.length - 1]![0];
}

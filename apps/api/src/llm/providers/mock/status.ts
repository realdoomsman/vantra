// The mock provider reads the STATUS block the runtime puts in the user turn (SPEC §8.8, B16).
// context.ts owns the exact wording, so parsing is deliberately tolerant: scan the text for JSON
// objects, take the first that looks like STATUS, then look up each field under any of its
// plausible names. A STATUS we cannot read yields a blank snapshot and the agent still acts.
import { MICRO, type Micro } from '@vantra/shared';

export interface MockStatus {
  model: string | null;
  treasuryMicro: Micro | null;
  runwayDays: number | null;
  aboutToDie: boolean;
  liveProjects: number;
  services: number;
  siteUrl: string | null;
  memoryNotes: number;
  ownerMessages: number;
}

export const BLANK_STATUS: MockStatus = {
  model: null, treasuryMicro: null, runwayDays: null, aboutToDie: false,
  liveProjects: 0, services: 0, siteUrl: null, memoryNotes: 0, ownerMessages: 0,
};

// Keys that make a JSON object recognisable as STATUS rather than some tool's output; at least two
// must resolve before we trust it.
const STATUS_MARKERS = [
  'model', 'treasuryMicro', 'treasuryUsd', 'treasury', 'runwayDays', 'runway', 'burnPerDayMicro',
  'projects', 'services', 'memory', 'walletPubkey', 'stepN', 'step', 'unsettledMicro', 'aboutToDie',
];

// `texts` are the user-turn texts newest first; the newest one that carries a STATUS object wins,
// which is the STATUS turn itself on round 1 and the step's opening turn on later rounds.
export function readStatus(texts: readonly string[]): MockStatus {
  for (const text of texts) {
    for (const json of jsonCandidates(text)) {
      if (STATUS_MARKERS.filter((k) => lookup(json, [k]) !== undefined).length >= 2) return fromJson(json);
    }
  }
  return { ...BLANK_STATUS };
}

function fromJson(root: Record<string, unknown>): MockStatus {
  const projects = asArray(lookup(root, ['projects']));
  return {
    model: asString(lookup(root, ['model', 'modelId'])),
    treasuryMicro: readMicro(root, ['treasuryMicro'], ['treasuryUsd', 'treasury']),
    runwayDays: asNumber(lookup(root, ['runwayDays', 'runway'])),
    aboutToDie: lookup(root, ['aboutToDie', 'dying']) === true,
    liveProjects: projects.filter((p) => asString(lookup(p, ['status'])) === 'live').length,
    services: asArray(lookup(root, ['services'])).length,
    siteUrl: asString(lookup(root, ['siteUrl', 'site'])),
    memoryNotes: countOr(lookup(root, ['memory', 'memoryNotes', 'notes'])),
    ownerMessages: countOr(lookup(root, ['ownerMessages', 'messagesFromOwner'])),
  };
}

// Money may arrive as micro-dollars, as a USD number, or as a formatted "$4.21".
function readMicro(root: unknown, microNames: string[], usdNames: string[]): Micro | null {
  const micro = asNumber(lookup(root, microNames));
  if (micro !== null) return Math.round(micro);
  const usd = asNumber(lookup(root, usdNames));
  return usd === null ? null : Math.round(usd * MICRO);
}

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Breadth-first key lookup so nested STATUS groupings ({ agent: { model } }) still resolve.
function lookup(root: unknown, names: readonly string[], maxDepth = 3): unknown {
  const wanted = new Set(names.map(normalize));
  let level: unknown[] = [root];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: unknown[] = [];
    for (const node of level) {
      if (!isRecord(node)) continue;
      for (const [key, value] of Object.entries(node)) {
        if (value !== null && value !== undefined && wanted.has(normalize(key))) return value;
      }
      for (const value of Object.values(node)) if (isRecord(value)) next.push(value);
    }
    level = next;
  }
  return undefined;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const m = /-?\d+(?:\.\d+)?/.exec(v.replace(/,/g, ''));
    if (m) return Number(m[0]);
  }
  return null;
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const countOr = (v: unknown): number => (Array.isArray(v) ? v.length : (asNumber(v) ?? 0));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const MAX_JSON_CANDIDATES = 32;

// Every balanced `{…}` in the text that parses as a non-trivial object, outermost first.
function* jsonCandidates(text: string): Generator<Record<string, unknown>> {
  let tried = 0;
  for (let i = text.indexOf('{'); i >= 0 && tried < MAX_JSON_CANDIDATES; i = text.indexOf('{', i + 1)) {
    tried++;
    const end = matchBrace(text, i);
    if (end < 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(i, end + 1));
    } catch {
      continue;   // not JSON at this offset — keep scanning
    }
    if (isRecord(parsed) && Object.keys(parsed).length >= 2) yield parsed;
  }
}

function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

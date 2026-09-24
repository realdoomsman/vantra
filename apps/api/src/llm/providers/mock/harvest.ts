// Identifiers and URLs the mock agent "reads" out of earlier tool results, exactly as a real model
// would: claim_bounty needs an id that only appeared in the list_bounties output. Ids follow
// lib/ids.ts (`bt_`, `sv_`, `pj_` + 10 lowercase alphanumerics).
import type { LlmMessage } from '../../../core/interfaces.js';

export interface HarvestedIds { bounties: string[]; services: string[]; projects: string[]; urls: string[] }

const ID_RE = /\b(bt|sv|pj)_[0-9a-z]{10}\b/g;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const MAX_PER_KIND = 8;

export function harvestIds(messages: readonly LlmMessage[]): HarvestedIds {
  const out: HarvestedIds = { bounties: [], services: [], projects: [], urls: [] };
  const seen = new Set<string>();
  for (const text of resultTexts(messages)) {
    for (const match of text.matchAll(ID_RE)) {
      const id = match[0];
      if (seen.has(id)) continue;
      seen.add(id);
      const bucket = match[1] === 'bt' ? out.bounties : match[1] === 'sv' ? out.services : out.projects;
      if (bucket.length < MAX_PER_KIND) bucket.push(id);
    }
    for (const match of text.matchAll(URL_RE)) {
      const url = match[0].replace(/[.,;]+$/, '');
      if (seen.has(url)) continue;
      seen.add(url);
      if (out.urls.length < MAX_PER_KIND) out.urls.push(url);
    }
  }
  return out;
}

// Whether every tool result in the most recent user turn failed — the mock then stops early
// instead of stacking more doomed calls, which is what the round budget is for.
export function lastRoundFailed(messages: readonly LlmMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const results = messages[i]!.content.filter((c) => c.type === 'tool_result');
    if (results.length > 0) return results.every((r) => r.type === 'tool_result' && r.isError === true);
  }
  return false;
}

// Tool results only: an id or URL the agent has not "seen" come back from a tool is one it could
// not plausibly know, and STATUS urls (profile, wallet explorer) are not work product.
function* resultTexts(messages: readonly LlmMessage[]): Generator<string> {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result') yield block.content;
    }
  }
}

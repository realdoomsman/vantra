// Shared HTTP plumbing for search providers: timeout, status check, JSON parse, result sanitising.
import type { SearchResult } from '../core/interfaces.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const SEARCH_TIMEOUT_MS = 10_000;
export const MAX_SEARCH_COUNT = 10;
const TITLE_MAX = 200;
const SNIPPET_MAX = 500;

export class SearchHttpError extends Error {
  override readonly name = 'SearchHttpError';
  constructor(readonly provider: string, readonly status: number, body: string) {
    super(`${provider} search failed: HTTP ${status}${body ? ` ${body.slice(0, 200)}` : ''}`);
  }
}

export async function fetchJson(fetchImpl: FetchLike, provider: string, url: string, init: RequestInit): Promise<unknown> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!res.ok) throw new SearchHttpError(provider, res.status, await res.text().catch(() => ''));
  return res.json() as Promise<unknown>;
}

export const clampCount = (count: number): number => Math.min(MAX_SEARCH_COUNT, Math.max(1, Math.floor(count) || 1));

// Drops non-http(s) URLs, strips markup from provider highlights, trims to sane lengths.
export function toResult(raw: { title?: unknown; url?: unknown; snippet?: unknown }): SearchResult | null {
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!/^https?:\/\//i.test(url)) return null;
  return {
    title: clean(raw.title, TITLE_MAX),
    url,
    snippet: clean(raw.snippet, SNIPPET_MAX),
  };
}

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

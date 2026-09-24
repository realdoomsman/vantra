// Tavily Search API (https://api.tavily.com/search). SEARCH_PROVIDER=tavily.
import type { SearchProvider, SearchResult } from '../core/interfaces.js';
import type { Logger } from '../lib/log.js';
import { type FetchLike, clampCount, fetchJson, toResult } from './http.js';

const ENDPOINT = 'https://api.tavily.com/search';

interface TavilyResponse { results?: { title?: unknown; url?: unknown; content?: unknown }[] }

export function createTavilySearch(apiKey: string, log: Logger, fetchImpl: FetchLike = fetch): SearchProvider {
  return {
    name: 'tavily',
    async search(q, count): Promise<SearchResult[]> {
      const body = (await fetchJson(fetchImpl, 'tavily', ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query: q, max_results: clampCount(count), search_depth: 'basic', include_answer: false, include_raw_content: false }),
      })) as TavilyResponse;
      const results = (body.results ?? [])
        .map((r) => toResult({ title: r.title, url: r.url, snippet: r.content }))
        .filter((r): r is SearchResult => r !== null);
      log.debug({ q, results: results.length }, 'tavily search');
      return results;
    },
  };
}

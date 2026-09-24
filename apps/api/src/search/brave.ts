// Brave Search API (https://api.search.brave.com/res/v1/web/search). SEARCH_PROVIDER=brave.
import type { SearchProvider, SearchResult } from '../core/interfaces.js';
import type { Logger } from '../lib/log.js';
import { type FetchLike, clampCount, fetchJson, toResult } from './http.js';

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

interface BraveResponse { web?: { results?: { title?: unknown; url?: unknown; description?: unknown }[] } }

export function createBraveSearch(apiKey: string, log: Logger, fetchImpl: FetchLike = fetch): SearchProvider {
  return {
    name: 'brave',
    async search(q, count): Promise<SearchResult[]> {
      const url = new URL(ENDPOINT);
      url.searchParams.set('q', q);
      url.searchParams.set('count', String(clampCount(count)));
      url.searchParams.set('text_decorations', 'false');
      const body = (await fetchJson(fetchImpl, 'brave', url.toString(), {
        headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': apiKey },
      })) as BraveResponse;
      const results = (body.web?.results ?? [])
        .map((r) => toResult({ title: r.title, url: r.url, snippet: r.description }))
        .filter((r): r is SearchResult => r !== null);
      log.debug({ q, results: results.length }, 'brave search');
      return results;
    },
  };
}

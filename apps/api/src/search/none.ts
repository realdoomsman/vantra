// SEARCH_PROVIDER=none: every search rejects, so the web_search tool returns an error result at no cost (SPEC §8.9).
import type { SearchProvider } from '../core/interfaces.js';

export const SEARCH_DISABLED_MESSAGE = 'Web search is not configured on this deployment (SEARCH_PROVIDER=none). Use fetch_url on known URLs instead.';

export class SearchDisabledError extends Error {
  override readonly name = 'SearchDisabledError';
  constructor() {
    super(SEARCH_DISABLED_MESSAGE);
  }
}

export function createNoneSearch(): SearchProvider {
  return {
    name: 'none',
    async search() {
      throw new SearchDisabledError();
    },
  };
}

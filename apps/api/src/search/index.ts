import type { Config } from '../config.js';
import type { SearchProvider } from '../core/interfaces.js';
import type { Logger } from '../lib/log.js';
import { createBraveSearch } from './brave.js';
import { createNoneSearch } from './none.js';
import { createTavilySearch } from './tavily.js';

// SEARCH_PROVIDER=brave | tavily | none ('none' rejects every search so web_search returns an error string, no cost). SPEC §8.9.
// config.ts already guarantees the matching API key is present.
export function createSearch(config: Config, log: Logger): SearchProvider {
  switch (config.search.provider) {
    case 'brave': return createBraveSearch(config.search.braveApiKey!, log);
    case 'tavily': return createTavilySearch(config.search.tavilyApiKey!, log);
    case 'none': return createNoneSearch();
  }
}

export { SEARCH_DISABLED_MESSAGE, SearchDisabledError } from './none.js';
export { MAX_SEARCH_COUNT, SearchHttpError } from './http.js';

// SEARCH_PROVIDER=brave | tavily | none (SPEC §8.2, §8.9 web_search).
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { silentLogger } from '../../src/lib/log.js';
import { createBraveSearch } from '../../src/search/brave.js';
import { MAX_SEARCH_COUNT, SearchHttpError } from '../../src/search/http.js';
import { createSearch } from '../../src/search/index.js';
import { SEARCH_DISABLED_MESSAGE, SearchDisabledError, createNoneSearch } from '../../src/search/none.js';
import { createTavilySearch } from '../../src/search/tavily.js';

interface Captured { url: string; init: RequestInit | undefined }

function fakeFetch(body: unknown, status = 200): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

describe('createSearch', () => {
  const config = (env: NodeJS.ProcessEnv) => loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...env });

  it('selects the provider named by SEARCH_PROVIDER', () => {
    expect(createSearch(config({}), silentLogger).name).toBe('none');
    expect(createSearch(config({ SEARCH_PROVIDER: 'brave', BRAVE_API_KEY: 'k' }), silentLogger).name).toBe('brave');
    expect(createSearch(config({ SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'k' }), silentLogger).name).toBe('tavily');
  });

  it('refuses a provider without its key at config time', () => {
    expect(() => config({ SEARCH_PROVIDER: 'brave' })).toThrow(/BRAVE_API_KEY/);
    expect(() => config({ SEARCH_PROVIDER: 'tavily' })).toThrow(/TAVILY_API_KEY/);
  });
});

describe("provider 'none'", () => {
  it('rejects every search so web_search can report it with no cost', async () => {
    const provider = createNoneSearch();
    expect(provider.name).toBe('none');
    await expect(provider.search('anything', 5)).rejects.toBeInstanceOf(SearchDisabledError);
    await expect(provider.search('anything', 5)).rejects.toThrow(SEARCH_DISABLED_MESSAGE);
  });
});

describe('brave', () => {
  const body = {
    web: {
      results: [
        { title: 'First <strong>hit</strong>', url: 'https://example.com/a', description: 'A  snippet\nwrapped' },
        { title: 'No protocol', url: 'ftp://example.com/b', description: 'dropped' },
        { title: 'Missing url', description: 'dropped' },
      ],
    },
  };

  it('maps results, strips markup and drops non-http urls', async () => {
    const { fetch, calls } = fakeFetch(body);
    const results = await createBraveSearch('brave-key', silentLogger, fetch).search('runway agents', 3);
    expect(results).toEqual([{ title: 'First hit', url: 'https://example.com/a', snippet: 'A snippet wrapped' }]);

    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(url.searchParams.get('q')).toBe('runway agents');
    expect(url.searchParams.get('count')).toBe('3');
    expect((calls[0]!.init!.headers as Record<string, string>)['X-Subscription-Token']).toBe('brave-key');
    expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
  });

  it('clamps the result count to 1..10', async () => {
    const { fetch, calls } = fakeFetch({ web: { results: [] } });
    const brave = createBraveSearch('k', silentLogger, fetch);
    await brave.search('q', 50);
    await brave.search('q', 0);
    expect(calls.map((c) => new URL(c.url).searchParams.get('count'))).toEqual([String(MAX_SEARCH_COUNT), '1']);
  });

  it('raises a typed error on a non-2xx response', async () => {
    const { fetch } = fakeFetch('rate limited', 429);
    await expect(createBraveSearch('k', silentLogger, fetch).search('q', 3)).rejects.toBeInstanceOf(SearchHttpError);
  });

  it('tolerates a response with no results', async () => {
    const { fetch } = fakeFetch({});
    await expect(createBraveSearch('k', silentLogger, fetch).search('q', 3)).resolves.toEqual([]);
  });
});

describe('tavily', () => {
  it('posts the query and maps content to snippet', async () => {
    const { fetch, calls } = fakeFetch({ results: [{ title: 'T', url: 'https://example.com/t', content: 'body text' }] });
    const results = await createTavilySearch('tavily-key', silentLogger, fetch).search('runway', 20);
    expect(results).toEqual([{ title: 'T', url: 'https://example.com/t', snippet: 'body text' }]);

    expect(calls[0]!.url).toBe('https://api.tavily.com/search');
    expect(calls[0]!.init!.method).toBe('POST');
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer tavily-key');
    expect(JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>).toMatchObject({ query: 'runway', max_results: MAX_SEARCH_COUNT });
  });

  it('raises a typed error on a non-2xx response', async () => {
    const { fetch } = fakeFetch('bad key', 401);
    await expect(createTavilySearch('k', silentLogger, fetch).search('q', 3)).rejects.toBeInstanceOf(SearchHttpError);
  });
});

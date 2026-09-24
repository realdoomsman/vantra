// ETH/USD price: Coinbase's public spot endpoint on mainnet (cached 60s, last good value or env
// fallback on failure), the ETH_PRICE_USD env value everywhere else (SPEC §8.12). Plus the
// gwei → micro-dollar valuation.
import type { Micro } from '@vantra/shared';
import type { Logger } from '../lib/log.js';

export const COINBASE_ETH_SPOT_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot';
export const PRICE_CACHE_MS = 60_000;
// Used only when ETH_PRICE_USD is unset and Coinbase is unreachable. Deliberately low: an
// under-valued ETH deposit credits too little, which is recoverable; over-valuing it is not.
// Kept equal to the ETH_PRICE_USD default in config.ts — two fallbacks in one process would be a
// mispriced deposit nobody notices.
export const FALLBACK_ETH_PRICE = 3_000;
const FETCH_TIMEOUT_MS = 5_000;
// Wei (1e18) overflows Number.MAX_SAFE_INTEGER, so every native balance in TypeScript is gwei — the
// same magnitude lamports had, which is why the stipends and DB columns did not have to change.
// Conversion to wei happens only at the viem boundary, in bigint.
export const GWEI_PER_ETH = 1_000_000_000;

// gwei × usd/ETH → micro-dollars. (gwei / 1e9) × price × 1e6 = gwei × price / 1e3.
export function gweiToMicro(gwei: number, ethPriceUsd: number): Micro {
  return Math.round((gwei * ethPriceUsd) / (GWEI_PER_ETH / 1_000_000));
}

export interface EthPriceSource { get(): Promise<number> }

export interface EthPriceOpts {
  cluster: string;
  fallbackUsd: number;
  log: Logger;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export function createEthPriceSource(opts: EthPriceOpts): EthPriceSource {
  const { cluster, fallbackUsd, log } = opts;
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  // Only mainnet ETH has a price worth asking about: on testnet and in memory mode the configured
  // value is the truth, and calling out would just add a network dependency to every sync.
  if (cluster !== 'mainnet') return { get: async () => fallbackUsd };

  let cached: { value: number; at: number } | null = null;
  let lastGood = fallbackUsd;
  let inflight: Promise<number> | null = null;

  const refresh = async (): Promise<number> => {
    try {
      const value = await fetchCoinbaseEthPrice(fetchFn);
      lastGood = value;
      cached = { value, at: now() };
      return value;
    } catch (e) {
      log.warn({ err: e, fallbackUsd: lastGood }, 'ETH price fetch failed; using last known value');
      cached = { value: lastGood, at: now() };
      return lastGood;
    }
  };

  return {
    async get() {
      if (cached && now() - cached.at < PRICE_CACHE_MS) return cached.value;
      inflight ??= refresh().finally(() => { inflight = null; });
      return inflight;
    },
  };
}

async function fetchCoinbaseEthPrice(fetchFn: typeof fetch): Promise<number> {
  const res = await fetchFn(COINBASE_ETH_SPOT_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Coinbase price API responded ${res.status}`);
  // { data: { base: 'ETH', currency: 'USD', amount: '3421.55' } } — the amount is a decimal STRING.
  const body = (await res.json()) as { data?: { amount?: unknown } };
  const price = Number(body.data?.amount);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Coinbase price API returned no ETH price');
  return price;
}

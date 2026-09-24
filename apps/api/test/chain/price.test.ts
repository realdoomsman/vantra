import { describe, expect, it, vi } from 'vitest';
import {
  COINBASE_ETH_SPOT_URL, FALLBACK_ETH_PRICE, PRICE_CACHE_MS, createEthPriceSource, gweiToMicro,
} from '../../src/chain/price.js';
import { silentLogger } from '../../src/lib/log.js';

// Coinbase answers { data: { base, currency, amount } } and `amount` is a decimal STRING.
const coinbase = (amount: unknown): typeof fetch =>
  vi.fn(async () => new Response(JSON.stringify({ data: { base: 'ETH', currency: 'USD', amount } }), { status: 200 })) as unknown as typeof fetch;

describe('chain/price', () => {
  it('values gwei in micro-dollars', () => {
    expect(gweiToMicro(1_000_000_000, 3_000)).toBe(3_000_000_000);   // 1 ETH at $3,000
    expect(gweiToMicro(5_000_000, 3_000)).toBe(15_000_000);          // the 0.005 ETH gas stipend
    expect(gweiToMicro(0, 3_000)).toBe(0);
    expect(gweiToMicro(1, 3_000)).toBe(3);                            // 1 gwei at $3,000 is 3 micro-dollars
    expect(gweiToMicro(1, 3_001)).toBe(3);                            // rounds, never fractional micro
  });

  it('uses ETH_PRICE_USD off mainnet and never calls the price API', async () => {
    const fetchFn = coinbase('999');
    const price = createEthPriceSource({ cluster: 'testnet', fallbackUsd: FALLBACK_ETH_PRICE, log: silentLogger, fetchFn });
    expect(await price.get()).toBe(FALLBACK_ETH_PRICE);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reads Coinbase spot on mainnet and caches for 60s', async () => {
    const fetchFn = coinbase('3421.55');
    let now = 1_000_000;
    const price = createEthPriceSource({ cluster: 'mainnet', fallbackUsd: FALLBACK_ETH_PRICE, log: silentLogger, fetchFn, now: () => now });

    expect(await price.get()).toBe(3421.55);
    expect(await price.get()).toBe(3421.55);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(COINBASE_ETH_SPOT_URL, expect.objectContaining({ headers: { accept: 'application/json' } }));

    now += PRICE_CACHE_MS + 1;
    expect(await price.get()).toBe(3421.55);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent refreshes into one request', async () => {
    const fetchFn = coinbase('100');
    const price = createEthPriceSource({ cluster: 'mainnet', fallbackUsd: FALLBACK_ETH_PRICE, log: silentLogger, fetchFn });
    expect(await Promise.all([price.get(), price.get(), price.get()])).toEqual([100, 100, 100]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('falls back to the last known price when the API fails or lies', async () => {
    const failing = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const price = createEthPriceSource({ cluster: 'mainnet', fallbackUsd: FALLBACK_ETH_PRICE, log: silentLogger, fetchFn: failing });
    expect(await price.get()).toBe(FALLBACK_ETH_PRICE);

    let now = 0;
    const flapping = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { amount: '1800' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response('null', { status: 500 })) as unknown as typeof fetch;
    const price2 = createEthPriceSource({ cluster: 'mainnet', fallbackUsd: FALLBACK_ETH_PRICE, log: silentLogger, fetchFn: flapping, now: () => now });
    expect(await price2.get()).toBe(1800);
    now += PRICE_CACHE_MS + 1;
    expect(await price2.get()).toBe(1800);   // keeps the last good value, not the env fallback

    const bogus = createEthPriceSource({ cluster: 'mainnet', fallbackUsd: FALLBACK_ETH_PRICE, log: silentLogger, fetchFn: coinbase('nope') });
    expect(await bogus.get()).toBe(FALLBACK_ETH_PRICE);
  });
});

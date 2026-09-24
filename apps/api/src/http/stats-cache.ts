// GET /api/stats and the WS hello share one 30-second memo of Services.stats() (SPEC §8.15).
// Each scheduler-driven `stats` broadcast refreshes it, so HTTP readers are never staler than the socket.
import type { GlobalStats } from '@vantra/shared';
import type { Deps } from '../core/interfaces.js';
import { servicesOf } from './context.js';

export const STATS_TTL_MS = 30_000;

export interface StatsCache {
  get(): Promise<GlobalStats>;
  /**
   * The flagship agent the landing page is a window onto. `MAIN_AGENT_ID` is the operator's
   * explicit pick and always wins; without it the colony nominates its own — the longest-lived
   * agent still breathing, which is `GlobalStats.oldestAlive` and therefore already computed by
   * the snapshot this cache memoizes. No extra query, and it moves on the same 30s cadence.
   */
  mainAgentId(): Promise<string | null>;
  close(): void;
}

export function createStatsCache(deps: Deps, ttlMs = STATS_TTL_MS): StatsCache {
  let cached: { stats: GlobalStats; at: number } | null = null;
  let inflight: Promise<GlobalStats> | null = null;
  const offBus = deps.bus.on('stats', (msg) => {
    cached = { stats: msg.stats, at: Date.now() };
  });

  const get = (): Promise<GlobalStats> => {
    if (cached && Date.now() - cached.at < ttlMs) return Promise.resolve(cached.stats);
    if (inflight) return inflight;
    inflight = servicesOf(deps).stats()
      .then((stats) => {
        cached = { stats, at: Date.now() };
        return stats;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    get,
    mainAgentId() {
      if (deps.config.mainAgentId) return Promise.resolve(deps.config.mainAgentId);
      // /api/health has to answer even when the read side cannot: an unavailable snapshot means
      // "no flagship known", never a failed health check.
      return get().then((stats) => stats.oldestAlive?.id ?? null, () => null);
    },
    close: offBus,
  };
}

import { create } from 'zustand';
import type { GlobalStats, HealthResponse, Me, SandboxName, TreasuryPublic } from '@vantra/shared';
import type { PaymentsHealth } from '../api/client';
import { paymentsHealthOf } from '../api/client';
import { useAgentsStore } from './agents';

export type WsState = 'connecting' | 'open' | 'closed';

export type ChainInfo = GlobalStats['chain'];

interface AppState {
  stats: GlobalStats | null;
  treasury: TreasuryPublic | null;
  chainInfo: ChainInfo | null;
  me: Me | null;
  /** True once /api/me has answered at least once (signed in or not). */
  meLoaded: boolean;
  version: string | null;
  /** `payments` block of /api/health (SPEC-V2 §5.9); null until health answers. */
  payments: PaymentsHealth | null;
  /** Is "Sign in with Google" configured on the server? */
  googleAuth: boolean;
  /** Flagship agent featured on the landing page (health.mainAgentId); null until known. */
  mainAgentId: string | null;
  /** Are agent token launches enabled server-side (health.tokenLaunch)? */
  tokenLaunch: boolean;
  /** health.sandbox; `none` means this deployment withholds every SANDBOX_TOOLS entry. Null until known. */
  sandbox: SandboxName | null;
  wsState: WsState;
  /** Epoch ms of the last WebSocket message; drives "synced {n}s ago". */
  lastSyncAt: number | null;

  setStats: (stats: GlobalStats) => void;
  setTreasury: (treasury: TreasuryPublic) => void;
  setMe: (me: Me | null) => void;
  setHealth: (health: HealthResponse) => void;
  setWsState: (state: WsState) => void;
  touchSync: () => void;
}

export const useAppStore = create<AppState>()((set) => ({
  stats: null,
  treasury: null,
  chainInfo: null,
  me: null,
  meLoaded: false,
  version: null,
  payments: null,
  googleAuth: false,
  mainAgentId: null,
  tokenLaunch: false,
  sandbox: null,
  wsState: 'closed',
  lastSyncAt: null,

  setStats: (stats) => set({ stats, treasury: stats.treasury, chainInfo: stats.chain }),
  setTreasury: (treasury) =>
    set((s) => ({ treasury, stats: s.stats ? { ...s.stats, treasury } : s.stats })),
  setMe: (me) => {
    // An owner may hold many agents in v2, so every one of them is seeded into the agents store.
    if (me && me.agents.length > 0) useAgentsStore.getState().upsert(me.agents);
    set({ me, meLoaded: true });
  },
  setHealth: (health) => set({
    version: health.version, payments: paymentsHealthOf(health), googleAuth: health.googleAuth,
    mainAgentId: health.mainAgentId, tokenLaunch: health.tokenLaunch, sandbox: health.sandbox,
  }),
  setWsState: (wsState) => set({ wsState }),
  touchSync: () => set({ lastSyncAt: Date.now() }),
}));

/** Selector helpers used across the shell. */
export const selectStats = (s: AppState) => s.stats;
export const selectMe = (s: AppState) => s.me;
export const selectIsDemo = (s: AppState) => s.stats?.demo === true;

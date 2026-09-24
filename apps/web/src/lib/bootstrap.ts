// Initial data load + WebSocket connection; runs once when the app mounts.
import { useEffect } from 'react';
import { api } from '../api/client';
import { connectWs, disconnectWs } from '../api/ws';
import { useAppStore } from '../store/app';
import { useFeedStore } from '../store/feed';
import { useWalletStore } from '../store/wallet';

const FEED_SEED = 50;

export function useBootstrap(): void {
  useEffect(() => {
    const app = useAppStore.getState();
    connectWs();
    api.stats().then(app.setStats).catch(() => undefined);
    api.health().then(app.setHealth).catch(() => undefined);
    api.events({ limit: FEED_SEED }).then(useFeedStore.getState().seedEvents).catch(() => undefined);
    void useWalletStore.getState().refreshMe();
    return () => disconnectWs();
  }, []);
}

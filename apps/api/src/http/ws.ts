// GET /ws (SPEC §8.16, AMENDMENTS C27): broadcast-only. Every bus message reaches every client;
// clients send nothing. Hello carries a fresh GlobalStats; pings every 25s drop dead sockets.
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { WS_PING_INTERVAL_MS, type WsMsg } from '@vantra/shared';
import type { Deps } from '../core/interfaces.js';
import { stripSensitive } from './sanitize.js';
import type { StatsCache } from './stats-cache.js';

const MAX_CLIENT_PAYLOAD_BYTES = 1024;

const encode = (msg: WsMsg): string => JSON.stringify(stripSensitive(msg));

export async function registerWs(app: FastifyInstance, deps: Deps, stats: StatsCache): Promise<void> {
  await app.register(websocket, { options: { maxPayload: MAX_CLIENT_PAYLOAD_BYTES, clientTracking: false } });
  const log = deps.log.child({ mod: 'ws' });
  const clients = new Map<WebSocket, { alive: boolean }>();

  const offBus = deps.bus.onAny((msg) => {
    if (clients.size === 0) return;
    const data = encode(msg);
    for (const socket of clients.keys()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    }
  });

  const pinger = setInterval(() => {
    for (const [socket, state] of clients) {
      if (!state.alive) {
        clients.delete(socket);
        socket.terminate();
        continue;
      }
      state.alive = false;
      socket.ping();
    }
  }, WS_PING_INTERVAL_MS);
  pinger.unref();

  app.get('/ws', { websocket: true }, (socket, request) => {
    const state = { alive: true };
    socket.on('pong', () => { state.alive = true; });
    socket.on('close', () => { clients.delete(socket); });
    socket.on('error', (err) => log.warn({ err, ip: request.ip }, 'ws client error'));
    socket.on('message', () => { /* protocol is server→client only */ });
    stats.get().then(
      (current) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(encode({ type: 'hello', stats: current }));
        clients.set(socket, state);
      },
      (err: unknown) => {
        log.error({ err }, 'ws hello failed');
        socket.close(1011, 'stats unavailable');
      },
    );
  });

  app.addHook('onClose', async () => {
    clearInterval(pinger);
    offBus();
    for (const socket of clients.keys()) socket.close(1001, 'server shutting down');
    clients.clear();
  });
}

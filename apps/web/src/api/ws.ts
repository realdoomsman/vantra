// Reconnecting WebSocket for /ws (SPEC §8.16 + AMENDMENTS C27). Broadcast
// only: every message type is routed into the zustand stores.
import type { WsMsg } from '@vantra/shared';
import { useAppStore } from '../store/app';
import { useAgentsStore } from '../store/agents';
import { stepItem, useFeedStore } from '../store/feed';

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
/** Server pings every 25s; if nothing arrives for this long the socket is presumed dead. */
const WATCHDOG_MS = 75_000;

let socket: WebSocket | null = null;
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
let wanted = false;

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export function connectWs(): void {
  wanted = true;
  if (socket) return;
  open();
}

export function disconnectWs(): void {
  wanted = false;
  clearTimers();
  socket?.close();
  socket = null;
  useAppStore.getState().setWsState('closed');
}

function open(): void {
  const { setWsState } = useAppStore.getState();
  setWsState('connecting');
  const ws = new WebSocket(wsUrl());
  socket = ws;

  ws.onopen = () => {
    if (socket !== ws) return;
    attempt = 0;
    setWsState('open');
    armWatchdog(ws);
  };
  ws.onmessage = (ev: MessageEvent<string>) => {
    if (socket !== ws) return;
    useAppStore.getState().touchSync();
    setWsState('open');         // belt and braces: traffic proves the socket is live
    armWatchdog(ws);
    let msg: WsMsg;
    try {
      msg = JSON.parse(ev.data) as WsMsg;
    } catch {
      return;
    }
    dispatch(msg);
  };
  ws.onerror = () => ws.close();
  // A superseded socket's close must be a complete no-op. StrictMode mounts (disconnect then connect)
  // routinely deliver A's close AFTER B's open, and clearing B's watchdog there leaves a silently dead
  // socket that never reconnects while the UI shows RECONNECTING with data still flowing.
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    clearTimers();
    setWsState('closed');
    if (wanted) scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  const delay = Math.round(base * (0.7 + Math.random() * 0.6));
  attempt = Math.min(attempt + 1, 10);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (wanted && !socket) open();
  }, delay);
}

function armWatchdog(ws: WebSocket): void {
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(() => {
    if (socket === ws) ws.close();
  }, WATCHDOG_MS);
}

function clearTimers(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (watchdogTimer) clearTimeout(watchdogTimer);
  reconnectTimer = null;
  watchdogTimer = null;
}

export function dispatch(msg: WsMsg): void {
  const app = useAppStore.getState();
  const agents = useAgentsStore.getState();
  const feed = useFeedStore.getState();
  const now = new Date().toISOString();

  switch (msg.type) {
    case 'hello':
    case 'stats':
      app.setStats(msg.stats);
      return;
    case 'treasury':
      app.setTreasury(msg.treasury);
      return;
    case 'event':
      feed.pushEvent(msg.event);
      return;
    case 'agent':
      agents.patch(msg.agentId, msg.patch);
      return;
    case 'step':
      agents.upsertStep(msg.step);
      if (msg.step.status !== 'running') feed.pushLive(msg.step.agentId, stepItem(msg.step));
      return;
    case 'step_start':
      feed.pushLive(msg.agentId, { kind: 'step_start', id: `step_start:${msg.stepId}`, ts: now, stepId: msg.stepId, n: msg.n, model: msg.model, effort: msg.effort });
      return;
    case 'tool':
      feed.pushLive(msg.agentId, {
        kind: 'tool',
        id: `tool:${msg.stepId}:${msg.round}:${msg.name}:${now}`,
        ts: now,
        stepId: msg.stepId,
        round: msg.round,
        name: msg.name,
        inputSummary: msg.inputSummary,
        costMicro: msg.costMicro,
        ok: msg.ok,
        ms: msg.ms,
      });
      return;
    case 'decision':
      feed.pushLive(msg.decision.agentId, { kind: 'decision', id: `decision:${msg.decision.id}`, ts: msg.decision.ts, decision: msg.decision });
      return;
    case 'ledger':
      feed.pushLive(msg.entry.agentId, { kind: 'ledger', id: `ledger:${msg.entry.id}`, ts: msg.entry.ts, entry: msg.entry });
      return;
    case 'project':
      agents.upsertProject(msg.project);
      feed.pushLive(msg.project.agentId, { kind: 'project', id: `project:${msg.project.id}:${msg.project.updatedAt}`, ts: msg.project.updatedAt, project: msg.project });
      return;
  }
}

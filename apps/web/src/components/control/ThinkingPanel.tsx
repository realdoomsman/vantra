// THINKING NOW (SPEC-V2 §9.7): the in-flight step, its round counter and the tool calls streaming
// in as they land.
//
// Two sources, merged on a clock. `GET /api/agents/:id/live` gives whatever already happened when
// the board opened; the WS `tool` messages give everything after that. Both are stamped with the
// browser's own clock (api/ws.ts sets `ts` at receive time), so "arrived after the fetch" is a
// sound dedupe rule and the same call can never render twice.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentDetail, AgentLiveState, Effort, LiveToolCall } from '@vantra/shared';
import { MAX_TOOL_ROUNDS_PER_STEP, fmtUsd } from '@vantra/shared';
import { api } from '../../api/client';
import { Countdown } from '../Countdown';
import { EmptyState } from '../EmptyState';
import { Panel } from '../Panel';
import { fmtTime } from '../../lib/format';
import { useAgentLive } from '../../store/feed';
import type { LiveItem } from '../../store/feed';

interface Header {
  stepId: number;
  n: number;
  model: string;
  effort: Effort;
  startedAt: string | null;
}

/** mm:ss since a start time, ticking once a second. */
function useElapsed(startedAt: string | null, running: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || !startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running, startedAt]);
  if (!startedAt) return '00:00';
  const s = Math.max(0, Math.round((now - Date.parse(startedAt)) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function ThinkingPanel({ agent }: { agent: AgentDetail }) {
  const items = useAgentLive(agent.id);
  const [initial, setInitial] = useState<{ state: AgentLiveState; at: string } | null>(null);
  const wasStepping = useRef(agent.stepping);

  const load = (id: string) => {
    api
      .agentLive(id)
      .then((state) => setInitial({ state, at: new Date().toISOString() }))
      .catch(() => undefined);
  };

  useEffect(() => {
    setInitial(null);
    load(agent.id);
  }, [agent.id]);

  // A step that starts while the board is open refetches once, so a board opened mid-step and a
  // board that watched the step begin show the same thing.
  useEffect(() => {
    if (agent.stepping && !wasStepping.current) load(agent.id);
    wasStepping.current = agent.stepping;
  }, [agent.stepping, agent.id]);

  const header = useMemo<Header | null>(() => {
    const started = newestStepStart(items);
    if (started) return started;
    const s = initial?.state.step;
    if (s) return { stepId: s.id, n: s.n, model: s.model, effort: s.effort, startedAt: s.startedAt };
    return null;
  }, [items, initial]);

  const tools = useMemo<LiveToolCall[]>(() => {
    if (!header) return [];
    const base =
      initial && initial.state.step?.id === header.stepId ? initial.state.tools : [];
    const since = initial?.at ?? '';
    const streamed: LiveToolCall[] = items
      .filter((it): it is Extract<LiveItem, { kind: 'tool' }> => it.kind === 'tool')
      .filter((it) => it.stepId === header.stepId && it.ts > since)
      .map((it) => ({
        round: it.round,
        name: it.name as LiveToolCall['name'],
        inputSummary: it.inputSummary,
        costMicro: it.costMicro,
        ok: it.ok,
        ms: it.ms,
        ts: it.ts,
      }));
    return [...base, ...streamed].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.round - b.round));
  }, [header, initial, items]);

  const stepping = agent.stepping;
  const startedAt = header?.startedAt ?? agent.currentStepStartedAt;
  const elapsed = useElapsed(startedAt, stepping);
  const round = Math.max(1, agent.currentRound ?? tools[tools.length - 1]?.round ?? initial?.state.round ?? 1);
  const spent = tools.reduce((sum, t) => sum + t.costMicro, 0);

  return (
    <Panel
      className="control-thinking"
      title="THINKING NOW"
      right={stepping ? <b className="pos">LIVE</b> : agent.status === 'dead' ? 'ENDED' : 'IDLE'}
    >
      {stepping && header ? (
        <>
          <div className="think-head">
            <span className="th-step">STEP {header.n}</span>
            <span className="chip">round {round}/{MAX_TOOL_ROUNDS_PER_STEP}</span>
            <span className="chip">{header.model}</span>
            <span className="chip">{header.effort}</span>
            <span className="spacer" />
            <span className="th-clock mono-num">{elapsed}</span>
          </div>
          <ToolStream tools={tools} />
          <div className="note">
            {tools.length === 0
              ? 'The model is composing its first move. Tool calls appear here the moment each one returns.'
              : `${tools.length} tool call${tools.length === 1 ? '' : 's'} this step · ${fmtUsd(spent)} in tool fees so far.`}
          </div>
        </>
      ) : agent.status === 'dead' ? (
        <EmptyState title="NOTHING LEFT TO THINK" text="this agent stopped when it ran out of money" />
      ) : (
        <div className="think-idle">
          <div className="ti-label">NEXT HEARTBEAT IN</div>
          <div className="ti-clock"><Countdown to={agent.nextStepAt} /></div>
          <div className="note">
            It thinks every {agent.heartbeatMin} minutes, and wakes early when you message it, when a bounty it can
            claim appears, or when money arrives.
          </div>
        </div>
      )}
    </Panel>
  );
}

function ToolStream({ tools }: { tools: LiveToolCall[] }) {
  if (tools.length === 0) return null;
  return (
    <div className="tool-stream">
      {tools.map((t, i) => (
        <div className={t.ok ? 'ts-row' : 'ts-row err'} key={`${t.round}:${t.name}:${t.ts}:${i}`}>
          <span className="ts-time">{fmtTime(t.ts)}</span>
          <span className="ts-round">r{t.round}</span>
          <span className="ts-name">{t.name}</span>
          <span className="ts-in">{t.inputSummary}</span>
          <span className="ts-ms">{t.ms}ms</span>
          <span className={t.costMicro > 0 ? 'ts-cost neg' : 'ts-cost'}>{t.costMicro > 0 ? `−${fmtUsd(t.costMicro)}` : '—'}</span>
          <span className={t.ok ? 'ts-ok pos' : 'ts-ok neg'}>{t.ok ? 'OK' : 'ERR'}</span>
        </div>
      ))}
    </div>
  );
}

function newestStepStart(items: LiveItem[]): Header | null {
  for (const it of items) {
    if (it.kind === 'step_start') {
      return { stepId: it.stepId, n: it.n, model: it.model, effort: it.effort, startedAt: it.ts };
    }
  }
  return null;
}

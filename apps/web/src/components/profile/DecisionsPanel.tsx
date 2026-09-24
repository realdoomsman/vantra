// Decision log: the detail payload merged with decisions arriving over WS,
// timestamped D+{day} HH:MM relative to birth (AMENDMENTS D32/D38).
import { useMemo } from 'react';
import type { Decision } from '@vantra/shared';
import { Countdown } from '../Countdown';
import { EmptyState } from '../EmptyState';
import { Panel } from '../Panel';
import type { ProfileProps } from './common';
import { fmtDecisionDay } from '../../lib/format';
import { useAgentLive } from '../../store/feed';
import type { LiveItem } from '../../store/feed';

const LIMIT = 80;

export function DecisionsPanel({ agent }: ProfileProps) {
  const live = useAgentLive(agent.id);
  const rows = useMemo(() => mergeDecisions(agent.decisions, live), [agent.decisions, live]);

  return (
    <Panel title="DECISION LOG" right={`${rows.length} entries`} flush>
      {rows.length === 0 ? (
        <EmptyState
          title="WAITING FOR FIRST HEARTBEAT"
          text={
            <>
              next step in <Countdown to={agent.nextStepAt} />
            </>
          }
        />
      ) : (
        <div className="decision-log scroll-box">
          {rows.map((d) => (
            <div className={`decision-row ${d.kind}`} key={d.id}>
              <div className="decision-day">{fmtDecisionDay(d.ts, agent.bornAt)}</div>
              <div className="decision-text">{d.text}</div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function mergeDecisions(fromDetail: Decision[], live: LiveItem[]): Decision[] {
  const byId = new Map<number, Decision>();
  for (const d of fromDetail) byId.set(d.id, d);
  for (const item of live) if (item.kind === 'decision') byId.set(item.decision.id, item.decision);
  return [...byId.values()].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.id - a.id)).slice(0, LIMIT);
}

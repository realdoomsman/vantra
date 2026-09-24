import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { FeedEvent } from '@vantra/shared';
import { fmtUsd } from '@vantra/shared';
import { EmptyState } from './EmptyState';
import { fmtSigned } from './Money';
import { fmtTime } from '../lib/format';
import type { LiveItem } from '../store/feed';

interface FeedProps {
  events: FeedEvent[];
  limit?: number;
  /** Show the D38 empty state with a BUY button when there are no events. */
  emptyAction?: boolean;
}

/** Global feed rows (D32): time · kind dot · text with agent link · amount. */
export function Feed({ events, limit, emptyAction = true }: FeedProps) {
  const rows = limit ? events.slice(0, limit) : events;
  if (rows.length === 0) {
    return (
      <EmptyState title="NO EVENTS YET" text="the first purchase opens the observatory">
        {emptyAction && (
          <Link to="/buy" className="btn-ghost" style={{ display: 'inline-block' }}>
            BUY AN AGENT
          </Link>
        )}
      </EmptyState>
    );
  }
  return (
    <div className="feed">
      {rows.map((e) => (
        <FeedRow key={e.id} ts={e.ts} kind={e.kind} amountMicro={e.amountMicro}>
          <AgentText agentId={e.agentId} agentName={e.agentName} text={e.text} />
        </FeedRow>
      ))}
    </div>
  );
}

interface FeedRowProps {
  ts: string;
  kind: string;
  /** Extra class on the dot (e.g. 'err', 'pos'). */
  dotClass?: string;
  amountMicro?: number | null;
  children: ReactNode;
}

export function FeedRow({ ts, kind, dotClass, amountMicro, children }: FeedRowProps) {
  return (
    <div className={`feed-row ${kind}`}>
      <span className="feed-time">{fmtTime(ts)}</span>
      <span className="feed-kind">
        <i className={dotClass ? `k-${kind} ${dotClass}` : `k-${kind}`} />
      </span>
      <span className="feed-text">{children}</span>
      {amountMicro !== null && amountMicro !== undefined && amountMicro !== 0 && (
        <span className={`feed-amt ${amountMicro > 0 ? 'pos' : 'neg'}`}>{fmtSigned(amountMicro)}</span>
      )}
    </div>
  );
}

/** Event text with the agent name linked once (D32); avoids "NAME NAME did…". */
export function AgentText({ agentId, agentName, text }: { agentId: string | null; agentName: string | null; text: string }) {
  if (!agentId || !agentName) return <>{text}</>;
  const link = <Link className="hl" to={`/a/${agentId}`}>{agentName}</Link>;
  if (text.startsWith(agentName)) {
    return (
      <>
        {link}
        {text.slice(agentName.length)}
      </>
    );
  }
  return (
    <>
      {link} {text}
    </>
  );
}

interface LiveFeedProps {
  items: LiveItem[];
  limit?: number;
  empty?: ReactNode;
}

/** Per-agent LIVE panel rows (D33): step_start / tool / decision / event / ledger / project. */
export function LiveFeed({ items, limit, empty }: LiveFeedProps) {
  const rows = limit ? items.slice(0, limit) : items;
  if (rows.length === 0) return <>{empty ?? <EmptyState title="NOTHING YET" />}</>;
  return (
    <div className="feed">
      {rows.map((it) => (
        <LiveRow key={it.id} item={it} />
      ))}
    </div>
  );
}

function LiveRow({ item }: { item: LiveItem }) {
  switch (item.kind) {
    case 'event':
      return (
        <FeedRow ts={item.ts} kind={item.event.kind} amountMicro={item.event.amountMicro}>
          <AgentText agentId={item.event.agentId} agentName={item.event.agentName} text={item.event.text} />
        </FeedRow>
      );
    case 'step_start':
      return (
        <FeedRow ts={item.ts} kind="step_start">
          step {item.n} started · <span className="hl">{item.model}</span> · {item.effort}
        </FeedRow>
      );
    case 'step':
      return (
        <FeedRow ts={item.ts} kind="step_start" amountMicro={-item.step.costMicro}>
          step {item.step.n} {item.step.status} · {item.step.summary || '(no summary)'}
        </FeedRow>
      );
    case 'tool':
      return (
        <FeedRow ts={item.ts} kind="tool" dotClass={item.ok ? undefined : 'err'} amountMicro={-item.costMicro}>
          <span className="feed-tool">{item.name}</span> {item.inputSummary} <span className="feed-ms">{item.ms}ms{item.ok ? '' : ' · error'}</span>
        </FeedRow>
      );
    case 'decision':
      return (
        <FeedRow ts={item.ts} kind="decision">
          <span className="hl">{item.decision.kind}</span> · {item.decision.text}
        </FeedRow>
      );
    case 'ledger':
      return (
        <FeedRow ts={item.ts} kind="ledger" dotClass={item.entry.amountMicro >= 0 ? 'pos' : 'neg'} amountMicro={item.entry.amountMicro}>
          {item.entry.kind} · {item.entry.memo} · bal {fmtUsd(item.entry.balanceAfterMicro)}
        </FeedRow>
      );
    case 'project':
      return (
        <FeedRow ts={item.ts} kind="project">
          project <span className="hl">{item.project.name}</span> · {item.project.kind} · {item.project.status}
          {item.project.url && (
            <>
              {' '}
              <a href={item.project.url} target="_blank" rel="noreferrer">↗</a>
            </>
          )}
        </FeedRow>
      );
  }
}

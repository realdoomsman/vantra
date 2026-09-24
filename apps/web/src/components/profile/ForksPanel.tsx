// Lineage: the parent this agent was forked from and the children paying royalties.
import { Link } from 'react-router-dom';
import { FORK_ROYALTY_BPS, fmtUsd } from '@vantra/shared';
import { EmptyState } from '../EmptyState';
import { Panel } from '../Panel';
import type { ProfileProps } from './common';

const royaltyPct = (FORK_ROYALTY_BPS / 100).toFixed(1).replace(/\.0$/, '');

export function ForksPanel({ agent }: ProfileProps) {
  const { parent, children } = agent;
  const royalties = children.reduce((a, c) => a + c.royaltiesPaidMicro, 0);

  return (
    <Panel title="FORKS" right={`gen ${agent.generation} · ${royaltyPct}% of a child's external revenue`} flush>
      {!parent && children.length === 0 ? (
        <EmptyState title="NO LINEAGE" text="not forked from anyone, and nobody has forked it" />
      ) : (
        <>
          {parent && (
            <div className="list-row">
              <span className="chip">PARENT</span>
              <span className="lr-main">
                <Link to={`/a/${parent.id}`}>
                  <b>{parent.name}</b>
                </Link>
                <span className="lr-sub">{parent.status}</span>
              </span>
              <span className="lr-val mono-num">
                <span className="neg">{fmtUsd(agent.royaltyOutMicro)}</span>
                <span className="lr-sub">royalties paid</span>
              </span>
            </div>
          )}
          {children.map((c) => (
            <div className="list-row" key={c.id}>
              <span className="chip">CHILD</span>
              <span className="lr-main">
                <Link to={`/a/${c.id}`}>
                  <b>{c.name}</b>
                </Link>
                <span className="lr-sub">{c.status}</span>
              </span>
              <span className="lr-val mono-num">
                <span className={c.royaltiesPaidMicro > 0 ? 'pos' : 'dim'}>{fmtUsd(c.royaltiesPaidMicro)}</span>
                <span className="lr-sub">royalties in</span>
              </span>
            </div>
          ))}
          {children.length > 0 && (
            <div className="list-row">
              <span className="lr-main dim">TOTAL ROYALTIES RECEIVED</span>
              <span className="lr-val mono-num">
                <span className={royalties > 0 ? 'pos' : 'dim'}>{fmtUsd(royalties)}</span>
              </span>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

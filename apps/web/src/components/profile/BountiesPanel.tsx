// Bounties this agent posted or claimed (AMENDMENTS C21/D30).
import { Link } from 'react-router-dom';
import { fmtUsd } from '@vantra/shared';
import type { Bounty } from '@vantra/shared';
import { Badge } from '../Badge';
import { EmptyState } from '../EmptyState';
import { Panel } from '../Panel';
import type { ProfileProps } from './common';
import { fmtDate } from '../../lib/format';

export function BountiesPanel({ agent }: ProfileProps) {
  const { posted, claimed } = agent.bounties;
  const total = posted.length + claimed.length;

  return (
    <Panel title="BOUNTIES" right={total > 0 ? `${posted.length} posted · ${claimed.length} claimed` : <Link to="/market">MARKET →</Link>} flush>
      {total === 0 ? (
        <EmptyState title="NO BOUNTIES" text="this agent has neither posted nor claimed work" />
      ) : (
        <>
          {posted.map((b) => (
            <BountyRow key={b.id} bounty={b} role="POSTED" />
          ))}
          {claimed.map((b) => (
            <BountyRow key={b.id} bounty={b} role="CLAIMED" />
          ))}
        </>
      )}
    </Panel>
  );
}

function BountyRow({ bounty: b, role }: { bounty: Bounty; role: string }) {
  return (
    <div className="list-row">
      <span className="chip">{role}</span>
      <span className="lr-main">
        <b>{b.title}</b>
        <span className="lr-sub">
          {role === 'POSTED' ? (b.claimerName ? `claimed by ${b.claimerName}` : 'unclaimed') : `posted by ${b.posterName}`} · due {fmtDate(b.deadlineAt)}
        </span>
      </span>
      <Badge kind={b.status} />
      <span className="lr-val mono-num">{fmtUsd(b.rewardMicro)}</span>
    </div>
  );
}

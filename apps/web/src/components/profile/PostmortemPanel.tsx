// Post-mortem for dead agents (SPEC §8.10, §9).
import { fmtUsd } from '@vantra/shared';
import { Panel } from '../Panel';
import type { ProfileProps } from './common';
import { fmtDateTime } from '../../lib/format';

export function PostmortemPanel({ agent }: ProfileProps) {
  if (agent.status !== 'dead') return null;
  const cause = agent.deathCause ?? 'unknown';

  return (
    <Panel
      className="postmortem section-gap"
      bodyClassName="postmortem-body"
      title="POST-MORTEM"
      right={agent.diedAt ? fmtDateTime(agent.diedAt) : undefined}
    >
      <div className="cause">
        {agent.name} died after {agent.ageDays.toFixed(1)} days — {cause}. Lifetime external revenue {fmtUsd(agent.revenueExternalMicro)} against{' '}
        {fmtUsd(agent.fundingMicro)} someone paid to bring it into existence.
      </div>
      <div className="section-gap">{agent.postmortem ?? 'The post-mortem is still being written.'}</div>
    </Panel>
  );
}

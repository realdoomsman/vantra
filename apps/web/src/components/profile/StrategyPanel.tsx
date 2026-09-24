// Published strategy (only when the owner shares it) and the agent's memory notes.
import { Link } from 'react-router-dom';
import { MEMORY_MAX_NOTES } from '@vantra/shared';
import { Panel } from '../Panel';
import type { ProfileProps } from './common';

export function StrategyPanel({ agent }: ProfileProps) {
  // `isOwner` is server-computed: a claim owner's public `ownerWallet` is null, so comparing it to
  // the session would make every claim-owned agent look like it belonged to every claim visitor.
  const isOwner = agent.isOwner;
  if (!agent.strategy || !agent.shareStrategy) return null;

  return (
    <Panel
      title="PUBLISHED STRATEGY"
      right={isOwner ? 'public' : <Link to={`/buy?fork=${agent.id}`}>FORK IT →</Link>}
    >
      <div className="strategy-body">{agent.strategy}</div>
      <div className="note">
        Forking copies this strategy into a new agent; 5% of the child&apos;s external revenue is paid to {agent.name}.
      </div>
    </Panel>
  );
}

export function MemoryPanel({ agent }: ProfileProps) {
  if (agent.memory.length === 0) return null;
  return (
    <Panel title="MEMORY" right={`${agent.memory.length}/${MEMORY_MAX_NOTES} notes`} flush>
      {agent.memory.map((note, i) => (
        <div className="list-row" key={i}>
          <span className="faint mono-num">{String(i).padStart(2, '0')}</span>
          <span className="lr-main dim">{note}</span>
        </div>
      ))}
    </Panel>
  );
}

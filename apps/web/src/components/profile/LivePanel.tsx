// LIVE panel: the per-agent ring buffer of step starts, tool calls, decisions,
// ledger posts, projects and events (AMENDMENTS D33/D38).
import { Countdown } from '../Countdown';
import { EmptyState } from '../EmptyState';
import { LiveFeed } from '../Feed';
import { Panel } from '../Panel';
import type { ProfileProps } from './common';
import { useAgentLive } from '../../store/feed';

const LIMIT = 60;

export function LivePanel({ agent }: ProfileProps) {
  const items = useAgentLive(agent.id);

  return (
    <Panel
      title="LIVE"
      right={agent.stepping ? <b className="pos">THINKING</b> : agent.status === 'dead' ? 'ENDED' : agent.phase.toUpperCase()}
      flush
    >
      <div className="scroll-box">
        <LiveFeed
          items={items}
          limit={LIMIT}
          empty={
            agent.status === 'dead' ? (
              <EmptyState title="NOTHING LEFT TO REPORT" text="this agent stopped stepping when it died" />
            ) : (
              <EmptyState
                title="WAITING FOR FIRST HEARTBEAT"
                text={
                  <>
                    next step in <Countdown to={agent.nextStepAt} />
                  </>
                }
              />
            )
          }
        />
      </div>
    </Panel>
  );
}

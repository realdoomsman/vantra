// What the agent is actually building; live-upserted from the WS 'project' message.
import { fmtUsd } from '@vantra/shared';
import { EmptyState } from '../EmptyState';
import { Panel } from '../Panel';
import { useProjects } from './common';
import type { ProfileProps } from './common';
import { fmtAgo } from '../../lib/format';

export function ProjectsPanel({ agent }: ProfileProps) {
  const projects = useProjects(agent.id);
  const earning = projects.filter((p) => p.revenueMicro > 0).length;

  return (
    <Panel title="PROJECTS" right={projects.length > 0 ? `${earning}/${projects.length} earning` : undefined} flush>
      {projects.length === 0 ? (
        <EmptyState title="NO PROJECTS YET" text="nothing has been built or shipped so far" />
      ) : (
        projects.map((p) => (
          <div className="list-row" key={p.id}>
            <span className={`chip pj-${p.status}`}>{p.status}</span>
            <span className="lr-main">
              <b>{p.name}</b> <span className="faint">{p.kind}</span>
              <span className="lr-sub">{p.description}</span>
            </span>
            {p.url && (
              <a href={p.url} target="_blank" rel="noreferrer">
                OPEN ↗
              </a>
            )}
            <span className="lr-val mono-num">
              <span className={p.revenueMicro > 0 ? 'pos' : 'dim'}>{fmtUsd(p.revenueMicro)}</span>
              <span className="lr-sub">{fmtAgo(p.updatedAt)}</span>
            </span>
          </div>
        ))
      )}
    </Panel>
  );
}

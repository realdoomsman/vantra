// Paid endpoints this agent sells (AMENDMENTS C21/D33).
import { fmtUsd } from '@vantra/shared';
import { CopyButton } from '../CopyButton';
import { EmptyState } from '../EmptyState';
import { Panel } from '../Panel';
import type { ProfileProps } from './common';

export function ServicesPanel({ agent }: ProfileProps) {
  const services = agent.services;
  const revenue = services.reduce((a, s) => a + s.revenueMicro, 0);

  return (
    <Panel title="SERVICES" right={services.length > 0 ? `${fmtUsd(revenue)} earned` : undefined} flush>
      {services.length === 0 ? (
        <EmptyState title="NO SERVICES YET" text="this agent does not sell an endpoint" />
      ) : (
        services.map((s) => (
          <div className="list-row" key={s.id}>
            <span className={s.status === 'active' ? 'chip pj-live' : 'chip'}>{s.status}</span>
            <span className="lr-main">
              <b>{s.name}</b>
              <span className="lr-sub">{s.description}</span>
              <span className="lr-sub faint">{s.endpointUrl}</span>
            </span>
            <CopyButton text={s.endpointUrl} label="COPY URL" />
            <span className="lr-val mono-num">
              {fmtUsd(s.priceMicro)}/call
              <span className="lr-sub">
                {s.calls} calls · <span className={s.revenueMicro > 0 ? 'pos' : undefined}>{fmtUsd(s.revenueMicro)}</span>
              </span>
            </span>
          </div>
        ))
      )}
    </Panel>
  );
}

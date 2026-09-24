// STEPS table with the transcript drawer (AMENDMENTS D33).
import { useState } from 'react';
import { fmtUsd } from '@vantra/shared';
import type { StepPublic } from '@vantra/shared';
import { Countdown } from '../Countdown';
import { EmptyState } from '../EmptyState';
import { Panel } from '../Panel';
import { TranscriptDrawer } from './TranscriptDrawer';
import { useSteps } from './common';
import type { ProfileProps } from './common';
import { fmtCompact, fmtDecisionDay } from '../../lib/format';

export function StepsPanel({ agent }: ProfileProps) {
  const steps = useSteps(agent.id);
  const [open, setOpen] = useState<StepPublic | null>(null);

  return (
    <Panel title="STEPS" right={`${agent.totalSteps} total · click a row for the transcript`} flush>
      {steps.length === 0 ? (
        <EmptyState
          title="WAITING FOR FIRST HEARTBEAT"
          text={
            <>
              next step in <Countdown to={agent.nextStepAt} />
            </>
          }
        />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>when</th>
                <th>model</th>
                <th>effort</th>
                <th className="num">in/out</th>
                <th className="num">cache rd</th>
                <th className="num">cost</th>
                <th className="num">tools</th>
                <th>status</th>
                <th>summary</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => setOpen(s)}>
                  <td className="num">
                    {/* Focusable control for the drawer; the row onClick stays a mouse convenience. */}
                    <button type="button" className="row-toggle" onClick={(e) => { e.stopPropagation(); setOpen(s); }}>
                      {s.n}
                      <span className="sr-only"> open transcript</span>
                    </button>
                  </td>
                  <td>{fmtDecisionDay(s.startedAt, agent.bornAt)}</td>
                  <td className="dim">{s.model}</td>
                  <td className="dim">{s.effort}</td>
                  <td className="num">
                    {fmtCompact(s.inputTokens)}/{fmtCompact(s.outputTokens)}
                  </td>
                  <td className="num">{fmtCompact(s.cacheReadTokens)}</td>
                  <td className="num">{fmtUsd(s.costMicro)}</td>
                  <td className="num">{s.toolCalls}</td>
                  <td>
                    <span className={`chip st-${s.status}`} title={stepTitle(s)}>
                      {s.status}
                    </span>
                  </td>
                  <td className="wrap">{s.error ? <span className="neg">{s.error}</span> : s.summary || <span className="faint">(no summary)</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <TranscriptDrawer agentId={agent.id} step={open} onClose={() => setOpen(null)} />}
    </Panel>
  );
}

const stepTitle = (s: StepPublic): string =>
  `${s.rounds} round${s.rounds === 1 ? '' : 's'}${s.stopReason ? ` · stop: ${s.stopReason}` : ''}${s.error ? ` · ${s.error}` : ''}`;

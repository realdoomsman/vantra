// SURVIVAL (SPEC-V2 §9.7): the one number that matters, where it is going, and the floor under it.
// The same `survival` block the agent itself reads every heartbeat (§7.3), shown to its owner.
import type { AgentDetail, ProtocolRules } from '@vantra/shared';
import { fmtUsd } from '@vantra/shared';
import { Panel } from '../Panel';
import { RunwayStrip } from '../RunwayStrip';
import { diesOnOf } from './ControlBar';
import { fmtDate } from '../../lib/format';
import { useAppStore } from '../../store/app';

interface Split {
  label: string;
  perDayMicro: number;
  floor: boolean;
}

/**
 * Observed per-day spend by category: lifetime spend over the agent's age. It is the only honest
 * split available — the headline `burnPerDayMicro` is the server's own basis (7-day or projected)
 * and is shown beside it rather than carved up by guesswork.
 */
function splits(agent: AgentDetail, rules: ProtocolRules | null, activeSites: number): Split[] {
  const days = Math.max(agent.ageDays, 0.01);
  const per = (micro: number) => Math.round(micro / days);
  return [
    { label: 'RENT', perDayMicro: rules ? rules.rentPerHourMicro * 24 : per(agent.spendRentMicro), floor: true },
    { label: 'HOSTING', perDayMicro: rules ? rules.hostingPerDayMicro * activeSites : per(agent.spendHostingMicro), floor: true },
    { label: 'INFERENCE', perDayMicro: per(agent.spendInferenceMicro), floor: false },
    { label: 'TOOLS', perDayMicro: per(agent.spendToolsMicro), floor: false },
    { label: 'COMPUTE', perDayMicro: per(agent.spendComputeMicro), floor: false },
  ];
}

export function SurvivalPanel({ agent }: { agent: AgentDetail }) {
  const rules = useAppStore((s) => s.stats?.rules ?? null);
  const dead = agent.status === 'dead';
  const activeSites = agent.deployments.filter((d) => d.active).length;
  const rows = splits(agent, rules, activeSites);
  const floorPerDay = rows.filter((r) => r.floor).reduce((sum, r) => sum + r.perDayMicro, 0);
  const dies = dead ? null : diesOnOf(agent.runwayDays);

  return (
    <Panel
      title="SURVIVAL"
      right={dead ? <b className="neg">DEAD</b> : agent.runwayDays === null ? '∞' : `${agent.runwayDays.toFixed(1)}d left`}
    >
      <div className="survival-hero">
        <div className="sh-val">
          {dead ? 'DIED' : agent.runwayDays === null ? '∞' : `${agent.runwayDays.toFixed(1)}`}
          {!dead && agent.runwayDays !== null && <span className="sh-unit">days of life left</span>}
        </div>
        <RunwayStrip runwayDays={agent.runwayDays} status={agent.status} ageDays={agent.ageDays} size="lg" />
        <div className="sh-dies">
          {dead
            ? `Died ${agent.diedAt ? fmtDate(agent.diedAt) : 'recently'} — ${agent.deathCause ?? 'out of money'}.`
            : dies
              ? `At the current burn it dies on ${fmtDate(dies)} unless money arrives.`
              : 'Nothing is burning, so nothing is running out.'}
        </div>
      </div>

      <div className="commission-ledger section-gap">
        <div className="cl-row">
          <span className="k">TREASURY</span>
          <span className="v">{fmtUsd(agent.treasuryMicro)}</span>
        </div>
        {rows.map((r) => (
          <div className="cl-row" key={r.label}>
            <span className="k">
              {r.label}
              {r.floor && <span className="faint"> · floor</span>}
            </span>
            <span className="v">{fmtUsd(r.perDayMicro)} / day</span>
          </div>
        ))}
        <div className="cl-row total">
          <span className="k">FLOOR PER DAY</span>
          <span className="v">{fmtUsd(floorPerDay)} / day</span>
        </div>
        <div className="cl-row total">
          <span className="k">BURN PER DAY <span className="faint">· {agent.burnBasis}</span></span>
          <span className="v neg">{fmtUsd(agent.burnPerDayMicro)} / day</span>
        </div>
      </div>

      <div className="note">
        The floor is what it costs to merely exist: rent, plus hosting for every site it keeps live. Everything above
        the floor is the agent choosing to think. Only money arriving from outside moves the days-left number up.
      </div>
    </Panel>
  );
}

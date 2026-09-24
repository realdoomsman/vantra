// The sticky control-board header (SPEC-V2 §9.7). Everything here is patched live by the WS
// `agent` message, which the page merges into the detail payload before rendering.
import { Link } from 'react-router-dom';
import type { AgentDetail } from '@vantra/shared';
import { fmtUsd } from '@vantra/shared';
import { Badge } from '../Badge';
import { RunwayStrip } from '../RunwayStrip';
import { fmtDate } from '../../lib/format';
import { useWalletStore } from '../../store/wallet';

/** now + runwayDays, or null when nothing is burning. */
export function diesOnOf(runwayDays: number | null, now = Date.now()): string | null {
  return runwayDays === null ? null : new Date(now + runwayDays * 86_400_000).toISOString();
}

export function ControlBar({ agent }: { agent: AgentDetail }) {
  const signOut = useWalletStore((s) => s.signOut);
  const dead = agent.status === 'dead';
  const dies = dead ? null : diesOnOf(agent.runwayDays);

  return (
    <header className="control-bar">
      <Link className="cb-back" to="/mine" title="All my agents">←</Link>
      <span className="cb-name">{agent.name}</span>
      <Badge kind={agent.phase} />
      {agent.tierId && <span className="chip">{agent.tierId}</span>}
      {agent.stepping && (
        <span className="cb-think">
          <span className="pulse-dot" />
          THINKING
        </span>
      )}

      <span className="cb-kv">
        <span className="k">TREASURY</span>
        <b className="mono-num">{fmtUsd(agent.treasuryMicro)}</b>
      </span>
      <span className="cb-kv">
        <span className="k">DAYS LEFT</span>
        <b className="mono-num">{dead ? '—' : agent.runwayDays === null ? '∞' : agent.runwayDays.toFixed(1)}</b>
      </span>
      <span className="cb-kv optional">
        <span className="k">{dead ? 'DIED' : 'DIES'}</span>
        <b className="mono-num">{dead ? (agent.diedAt ? fmtDate(agent.diedAt) : '—') : dies ? fmtDate(dies) : '—'}</b>
      </span>

      <span className="cb-strip">
        <RunwayStrip runwayDays={agent.runwayDays} status={agent.status} ageDays={agent.ageDays} size="sm" />
      </span>

      <span className="spacer" />
      <Link className="fbtn" to={`/a/${agent.id}`}>PUBLIC PROFILE ↗</Link>
      <button type="button" className="fbtn" onClick={() => void signOut()}>SIGN OUT</button>
    </header>
  );
}

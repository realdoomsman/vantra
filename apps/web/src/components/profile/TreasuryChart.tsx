// Treasury over time: the server's ledger-derived series extended with every
// ledger row this session has seen (recent + live WS), so the line moves live.
import { useMemo } from 'react';
import { fmtUsd } from '@vantra/shared';
import type { AgentDetail, TreasuryPoint } from '@vantra/shared';
import { Panel } from '../Panel';
import { LineChart } from '../charts/LineChart';
import type { ProfileProps } from './common';
import { fmtDate, fmtDateTime, fmtTime } from '../../lib/format';
import { useAgentLive } from '../../store/feed';
import type { LiveItem } from '../../store/feed';

const MAX_POINTS = 240;
const TWO_DAYS_MS = 2 * 86_400_000;

export function TreasuryChart({ agent }: ProfileProps) {
  const live = useAgentLive(agent.id);
  const points = useMemo(() => treasuryPoints(agent, live), [agent, live]);
  const x = points.map((p) => p.ts);
  const span = points.length > 1 ? Date.parse(x[x.length - 1]!) - Date.parse(x[0]!) : 0;
  const formatX = span > TWO_DAYS_MS ? fmtDate : span > 0 ? fmtTime : fmtDateTime;

  return (
    <Panel title="TREASURY" right={fmtUsd(agent.treasuryMicro)}>
      <LineChart
        x={x}
        series={[{ key: 'treasury', label: 'TREASURY', color: 'accent', values: points.map((p) => p.treasuryMicro) }]}
        formatValue={(v) => fmtUsd(v, { compact: true })}
        formatX={formatX}
      />
    </Panel>
  );
}

/** Server series + ledger balances, deduped by timestamp, oldest first. */
function treasuryPoints(agent: AgentDetail, live: LiveItem[]): TreasuryPoint[] {
  const byTs = new Map<string, number>();
  for (const p of agent.series) byTs.set(p.ts, p.treasuryMicro);
  for (const e of agent.ledgerRecent) byTs.set(e.ts, e.balanceAfterMicro);
  for (const item of live) if (item.kind === 'ledger') byTs.set(item.entry.ts, item.entry.balanceAfterMicro);
  return [...byTs.entries()]
    .map(([ts, treasuryMicro]) => ({ ts, treasuryMicro }))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    .slice(-MAX_POINTS);
}

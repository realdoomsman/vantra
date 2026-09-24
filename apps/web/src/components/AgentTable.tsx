import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { AgentPublic } from '@vantra/shared';
import { fmtUsd } from '@vantra/shared';
import { AgentBadges } from './Badge';
import { SurvivalScore } from './profile/SurvivalScore';
import { EmptyState } from './EmptyState';
import { RunwayStrip } from './RunwayStrip';

export type AgentSortKey = 'treasury' | 'revenue' | 'burn' | 'runway' | 'age' | 'steps' | 'profit' | 'born';
export type SortDir = 'asc' | 'desc';

interface Column {
  key: string;
  label: string;
  sort?: AgentSortKey;
  num?: boolean;
}

const COLUMNS: Column[] = [
  { key: 'rank', label: '#' },
  { key: 'name', label: 'agent' },
  { key: 'status', label: 'status' },
  { key: 'survival', label: 'health' },
  { key: 'strip', label: 'life' },
  { key: 'treasury', label: 'treasury', sort: 'treasury', num: true },
  { key: 'revenue', label: 'ext rev', sort: 'revenue', num: true },
  { key: 'burn', label: 'burn/day', sort: 'burn', num: true },
  { key: 'runway', label: 'days', sort: 'runway', num: true },
  { key: 'age', label: 'age', sort: 'age', num: true },
  { key: 'model', label: 'model' },
  { key: 'steps', label: 'steps', sort: 'steps', num: true },
];

const sortValue = (a: AgentPublic, key: AgentSortKey): number => {
  switch (key) {
    case 'treasury': return a.treasuryMicro;
    case 'revenue': return a.revenueExternalMicro;
    case 'burn': return a.burnPerDayMicro;
    case 'runway': return a.runwayDays ?? Number.POSITIVE_INFINITY;
    case 'age': return a.ageDays;
    case 'steps': return a.totalSteps;
    case 'profit': return a.profitMicro;
    case 'born': return Date.parse(a.bornAt);
  }
};

/** Client-side sort matching the table's columns (nulls for runway sort as ∞). */
export function sortAgents(rows: AgentPublic[], key: AgentSortKey, dir: SortDir): AgentPublic[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => sign * (sortValue(a, key) - sortValue(b, key)));
}

interface AgentTableProps {
  rows: AgentPublic[];
  /** Controlled sort; when `onSort` is omitted the table sorts locally. */
  sort?: AgentSortKey;
  dir?: SortDir;
  onSort?: (key: AgentSortKey, dir: SortDir) => void;
  rankOffset?: number;
  /** Hide columns by key (e.g. ['model', 'steps'] for compact leaderboards). */
  hide?: string[];
  emptyTitle?: string;
  emptyText?: string;
  onRowClick?: (agent: AgentPublic) => void;
}

/** Sortable agent table (SPEC §9 Agents); row click navigates to the profile. */
export function AgentTable({ rows, sort, dir, onSort, rankOffset = 0, hide = [], emptyTitle = 'NO AGENTS YET', emptyText, onRowClick }: AgentTableProps) {
  const navigate = useNavigate();
  const [local, setLocal] = useState<{ key: AgentSortKey; dir: SortDir }>({ key: sort ?? 'treasury', dir: dir ?? 'desc' });
  const activeKey = onSort ? sort : local.key;
  const activeDir = onSort ? (dir ?? 'desc') : local.dir;

  const ordered = useMemo(() => (onSort || !activeKey ? rows : sortAgents(rows, activeKey, activeDir)), [rows, onSort, activeKey, activeDir]);
  const columns = COLUMNS.filter((c) => !hide.includes(c.key));

  const clickHead = (c: Column) => {
    if (!c.sort) return;
    const nextDir: SortDir = activeKey === c.sort && activeDir === 'desc' ? 'asc' : 'desc';
    if (onSort) onSort(c.sort, nextDir);
    else setLocal({ key: c.sort, dir: nextDir });
  };

  if (rows.length === 0) return <EmptyState title={emptyTitle} text={emptyText} />;

  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {columns.map((c) => {
              const arrow = c.sort && c.sort === activeKey ? (activeDir === 'asc' ? ' ↑' : ' ↓') : '';
              return (
                <th
                  key={c.key}
                  className={[c.num ? 'num' : '', c.sort ? 'sortable' : '', c.sort && c.sort === activeKey ? 'sorted' : ''].filter(Boolean).join(' ') || undefined}
                  aria-sort={c.sort && c.sort === activeKey ? (activeDir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {c.sort ? (
                    <button type="button" className="th-sort" onClick={() => clickHead(c)}>
                      {c.label}
                      {arrow}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {ordered.map((a, i) => (
            <tr
              key={a.id}
              className={a.status === 'dead' ? 'clickable row-dead' : 'clickable'}
              onClick={() => (onRowClick ? onRowClick(a) : navigate(`/a/${a.id}`))}
            >
              {columns.map((c) => (
                <td key={c.key} className={c.num ? 'num' : undefined}>
                  <Cell col={c.key} agent={a} rank={rankOffset + i + 1} linked={onRowClick === undefined} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ col, agent: a, rank, linked }: { col: string; agent: AgentPublic; rank: number; linked: boolean }) {
  switch (col) {
    case 'rank': return <span className="rank-num">{rank}</span>;
    // The name is a real link, so the row is reachable without a mouse; the row's own onClick is
    // just a bigger hit area for people who have one.
    case 'name':
      return (
        <>
          <div className="agent-name">
            {linked ? <Link className="row-link" to={`/a/${a.id}`}>{a.name}</Link> : a.name}
            {a.tokenTicker && <span className="ticker-chip">${a.tokenTicker}</span>}
          </div>
          <div className="agent-id">{a.id}</div>
        </>
      );
    case 'status': return <AgentBadges agent={a} />;
    case 'survival': return <SurvivalScore score={a.survivalScore} grade={a.survivalGrade} size="sm" />;
    case 'strip': return <RunwayStrip runwayDays={a.runwayDays} status={a.status} ageDays={a.ageDays} size="sm" />;
    case 'treasury': return <>{fmtUsd(a.treasuryMicro)}</>;
    case 'revenue': return <span className={a.revenueExternalMicro > 0 ? 'pos' : undefined}>{fmtUsd(a.revenueExternalMicro)}</span>;
    case 'burn': return <>{fmtUsd(a.burnPerDayMicro)}</>;
    case 'runway': return <>{a.status === 'dead' ? '—' : a.runwayDays === null ? '∞' : a.runwayDays.toFixed(1)}</>;
    case 'age': return <>{a.ageDays.toFixed(1)}d</>;
    case 'model': return <span className="dim">{a.model}</span>;
    case 'steps': return <>{a.totalSteps}</>;
    default: return null;
  }
}

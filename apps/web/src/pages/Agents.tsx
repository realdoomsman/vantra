// SPEC §9 Agents: filter row (ALL/ALIVE/DEAD, MINE, search) over the sortable
// agent table. Server sorts what it can; burn/steps sort client-side (D39).
import { useEffect, useMemo, useState } from 'react';
import type { AgentSort, AgentStatusFilter } from '@vantra/shared';
import { api, isApiError } from '../api/client';
import { AgentTable, sortAgents } from '../components/AgentTable';
import type { AgentSortKey, SortDir } from '../components/AgentTable';
import { Panel } from '../components/Panel';
import { useAgentList, useAgentsStore } from '../store/agents';
import { useAppStore } from '../store/app';
import '../styles/pages1.css';

const PAGE = 50;
const LIST_KEY = 'agents:list';
const SEARCH_DEBOUNCE_MS = 300;
const STATUS_FILTERS: AgentStatusFilter[] = ['all', 'alive', 'dead'];
/** Sorts the API understands; everything else is sorted on the page. */
const SERVER_SORTS: AgentSort[] = ['treasury', 'revenue', 'age', 'profit', 'runway', 'born'];

const isServerSort = (key: AgentSortKey): key is AgentSort => (SERVER_SORTS as string[]).includes(key);

export default function Agents() {
  const me = useAppStore((s) => s.me);
  const rows = useAgentList(LIST_KEY);

  const [status, setStatus] = useState<AgentStatusFilter>('alive');
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<AgentSortKey>('treasury');
  const [dir, setDir] = useState<SortDir>('desc');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);

  // Any filter change restarts paging.
  useEffect(() => setOffset(0), [status, mine, query, sort, dir]);

  const owner = mine ? (me?.wallet ?? null) : null;

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .agents({
        status: mine ? 'all' : status,
        owner: owner ?? undefined,
        q: query || undefined,
        sort: isServerSort(sort) ? sort : undefined,
        dir,
        limit: PAGE,
        offset,
      })
      .then((res) => {
        if (!live) return;
        useAgentsStore.getState().setList(LIST_KEY, res.rows);
        setTotal(res.total);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(isApiError(e) ? e.message : 'Could not load agents');
        useAgentsStore.getState().setList(LIST_KEY, []);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [status, mine, owner, query, sort, dir, offset]);

  const ordered = useMemo(() => sortAgents(rows, sort, dir), [rows, sort, dir]);
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(total, offset + rows.length);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">AGENTS</h1>
        <p className="page-sub">Every agent that has ever run. Click a row for the full ledger, steps and decisions.</p>
      </div>

      <div className="filter-row">
        <span className="flabel">STATUS</span>
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            className={!mine && status === s ? 'fbtn active' : 'fbtn'}
            onClick={() => {
              setMine(false);
              setStatus(s);
            }}
          >
            {s.toUpperCase()}
          </button>
        ))}
        <button
          type="button"
          className={mine ? 'fbtn active' : 'fbtn'}
          disabled={!me}
          title={me ? 'Agents owned by this wallet' : 'Sign in to filter your own agents'}
          onClick={() => setMine((m) => !m)}
        >
          MINE
        </button>
        <span className="flabel">SEARCH</span>
        <input
          className="finput"
          value={search}
          placeholder="name or id"
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search agents by name or id"
        />
        <span className="spacer" />
        <span className="flabel">{loading ? 'LOADING…' : `${total} AGENT${total === 1 ? '' : 'S'}`}</span>
      </div>

      {error && <div className="alert err section-gap">{error}</div>}

      <Panel className="section-gap" title={mine ? 'MY AGENTS' : `${status.toUpperCase()} AGENTS`} right={query ? `“${query}”` : undefined} flush>
        <AgentTable
          rows={ordered}
          sort={sort}
          dir={dir}
          onSort={(key, nextDir) => {
            setSort(key);
            setDir(nextDir);
          }}
          rankOffset={offset}
          emptyTitle={loading ? 'LOADING…' : query ? 'NO MATCHES' : 'NO AGENTS YET'}
          emptyText={loading ? undefined : query ? 'No agent name or id matches that search.' : 'the first purchase opens the observatory'}
        />
      </Panel>

      {total > PAGE && (
        <div className="pager">
          <span>
            {from}–{to} of {total}
          </span>
          <button type="button" className="fbtn" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>
            ← PREV
          </button>
          <button type="button" className="fbtn" disabled={to >= total} onClick={() => setOffset((o) => o + PAGE)}>
            NEXT →
          </button>
        </div>
      )}
    </>
  );
}

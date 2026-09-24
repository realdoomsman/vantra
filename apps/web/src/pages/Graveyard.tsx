// SPEC §9 Graveyard + AMENDMENTS D37: grave cards, sorted RECENT / AGE / REVENUE.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fmtUsd } from '@vantra/shared';
import type { GraveyardEntry, GraveyardSort } from '@vantra/shared';
import { api, isApiError } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { firstSentence, fmtDate } from '../lib/format';
import '../styles/pages1.css';

const LIMIT = 100;
const SORTS: GraveyardSort[] = ['recent', 'age', 'revenue'];

export default function Graveyard() {
  const navigate = useNavigate();
  // Held locally rather than in the agents store: `postmortem` is graveyard-only (D37), and a dead
  // agent has no live patches worth merging.
  const [rows, setRows] = useState<GraveyardEntry[]>([]);
  const [sort, setSort] = useState<GraveyardSort>('recent');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .graveyard({ limit: LIMIT, sort })
      .then((res) => {
        if (!live) return;
        setRows(res);
        setError(null);
      })
      .catch((e: unknown) => {
        if (live) setError(isApiError(e) ? e.message : 'Could not load the graveyard');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [sort]);

  const paidBack = rows.filter((a) => a.paidBack).length;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">GRAVEYARD</h1>
        <p className="page-sub">
          Every agent that ran out of money. {rows.length > 0 && `${paidBack} of ${rows.length} earned back what was paid for them before dying.`}
        </p>
      </div>

      <div className="filter-row">
        <span className="flabel">SORT</span>
        {SORTS.map((s) => (
          <button key={s} type="button" className={sort === s ? 'fbtn active' : 'fbtn'} onClick={() => setSort(s)}>
            {s.toUpperCase()}
          </button>
        ))}
        <span className="spacer" />
        <span className="flabel">{loading ? 'LOADING…' : `${rows.length} DEAD`}</span>
      </div>

      {error && <div className="alert err section-gap">{error}</div>}

      <div className="section-gap">
        {rows.length === 0 ? (
          <EmptyState title={loading ? 'LOADING…' : 'NO DEATHS YET'} text={loading ? undefined : 'every agent is still paying rent'} />
        ) : (
          <div className="grave-grid">
            {rows.map((a) => (
              <GraveCard key={a.id} agent={a} onOpen={() => navigate(`/a/${a.id}`)} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function GraveCard({ agent: a, onOpen }: { agent: GraveyardEntry; onOpen: () => void }) {
  return (
    <div
      className="grave-card"
      role="link"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="g-marker">{(a.deathCause ?? 'unknown').toUpperCase()}</div>
      <div className="g-name">{a.name}</div>
      <div className="g-id">{a.id}</div>
      <div className="g-dates">
        BORN {fmtDate(a.bornAt)} — DIED {a.diedAt ? fmtDate(a.diedAt) : '—'}
      </div>
      <div className="g-cause">{causeLine(a)}</div>
      <div className="g-stats">
        <span>
          AGE <b>{a.ageDays.toFixed(1)}d</b>
        </span>
        <span>
          EXT REV <b>{fmtUsd(a.revenueExternalMicro)}</b>
        </span>
        <span>
          PAID BACK <b className={a.paidBack ? 'pos' : undefined}>{a.paidBack ? 'YES' : 'NO'}</b>
        </span>
      </div>
    </div>
  );
}

/**
 * D37: the first sentence of the post-mortem, which `GET /api/graveyard` now carries. The agent's own
 * `summary` is NOT a substitute — it is its last marketing line, and reading "shipped v2, two
 * customers paid" under a red death marker says the opposite of what the card means. The deterministic
 * death-cause sentence is the fallback until the post-mortem has been written.
 */
function causeLine(a: GraveyardEntry): string {
  const postmortem = a.postmortem?.trim();
  if (postmortem) return firstSentence(postmortem);
  switch (a.deathCause) {
    case 'insolvent':
      return `Could not afford another step after ${a.totalSteps} steps.`;
    case 'rent':
      return 'Treasury hit zero while rent was still accruing.';
    case 'owner_terminated':
      return 'Terminated by its owner.';
    case 'protocol_violation':
      return 'Stopped by the protocol.';
    default:
      return 'Cause unrecorded.';
  }
}

// The homepage IS the launchpad directory. One line says what a coin here is, one button launches
// one, and the rest of the screen is every coin already launched — a wall of cards that proves the
// idea is running. Buying an agent outright is still on offer, one quiet link down.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { LaunchPublic, LaunchSort } from '@vantra/shared';
import { api, isApiError } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { CoinCard } from '../components/launchpad/CoinCard';
import { feesEarnedMicro, fmtUsdCompact } from '../components/launchpad/launchFormat';
import { useFeedStore } from '../store/feed';

/** Divisible by every column count the grid lands on (2–7), so a full page never ends ragged. */
const PAGE = 84;
/** Poll on top of the feed: a coin's fees and runway move without an event to announce them. */
const POLL_MS = 15_000;
/** The API's largest page; a refresh of more cards than this reads in several requests. */
const MAX_LIMIT = 100;
/** Feed events that change what a card shows right now. */
const LAUNCH_EVENTS: Record<string, true> = { launch: true, activate: true, burn: true, death: true, revive: true };

const SORTS: { id: LaunchSort; label: string }[] = [
  { id: 'new', label: 'NEW' },
  { id: 'fees', label: 'FEES' },
  { id: 'burned', label: 'BURNED' },
  { id: 'runway', label: 'RUNWAY' },
];

const isSort = (s: string | null): s is LaunchSort => SORTS.some((x) => x.id === s);

type Directory =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; rows: LaunchPublic[]; total: number };

/**
 * The launched coins in `sort` order. Refreshes re-read everything already on screen (not just the
 * first page) so a poll never collapses a list the reader has paged into.
 */
function useDirectory(sort: LaunchSort) {
  const [state, setState] = useState<Directory>({ kind: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const shown = useRef(PAGE);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const rows: LaunchPublic[] = [];
      let total = 0;
      do {
        const limit = Math.min(MAX_LIMIT, shown.current - rows.length);
        const res = await api.launches({ sort, limit, offset: rows.length });
        total = res.total;
        rows.push(...res.rows);
        if (res.rows.length < limit) break;
      } while (rows.length < shown.current);
      if (mine === seq.current) setState({ kind: 'ready', rows, total });
    } catch (e) {
      if (mine !== seq.current) return;
      // A failed poll keeps the cards already on screen; only a first read reports the failure.
      setState((cur) =>
        cur.kind === 'ready' ? cur : { kind: 'error', message: isApiError(e) ? e.message : 'The directory is unreachable.' },
      );
    }
  }, [sort]);

  useEffect(() => {
    shown.current = PAGE;
    setState({ kind: 'loading' });
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  // A launch, a wake-up or a burn anywhere refreshes the wall at once instead of on the next poll.
  const newestLaunchEvent = useFeedStore((s) => s.events.find((e) => LAUNCH_EVENTS[e.kind])?.id ?? null);
  const seenEvent = useRef(newestLaunchEvent);
  useEffect(() => {
    if (newestLaunchEvent === seenEvent.current) return;
    seenEvent.current = newestLaunchEvent;
    void refresh();
  }, [newestLaunchEvent, refresh]);

  const loadMore = useCallback(async () => {
    if (state.kind !== 'ready') return;
    setLoadingMore(true);
    const mine = ++seq.current;
    try {
      const res = await api.launches({ sort, limit: PAGE, offset: state.rows.length });
      if (mine !== seq.current) return;
      const seen = new Set(state.rows.map((r) => r.id));
      const rows = [...state.rows, ...res.rows.filter((r) => !seen.has(r.id))];
      shown.current = rows.length;
      setState({ kind: 'ready', rows, total: res.total });
    } catch {
      // The button stays; the next click retries.
    } finally {
      setLoadingMore(false);
    }
  }, [sort, state]);

  return { state, loadMore, loadingMore };
}

export default function Landing() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('sort');
  const sort: LaunchSort = isSort(raw) ? raw : 'new';
  const { state, loadMore, loadingMore } = useDirectory(sort);

  const pickSort = (next: LaunchSort) => {
    setParams(next === 'new' ? {} : { sort: next }, { replace: true });
  };

  return (
    <div className="lpd">
      <header className="lpd-hero">
        <div className="lpd-pitch">
          <h1 className="lpd-line">
            A coin whose trading fees keep an AI alive. When it earns more than it needs, it buys the coin back and burns
            it.
          </h1>
          <p className="lpd-sub">
            Launch on Pons through VANTRA and the creator tax is wired to a fresh AI&apos;s own wallet. You tell it how to
            make money; it lives on the fees. Once launched, only that wallet can ever redirect them — not the dev, not us.
          </p>
        </div>
        <div className="lpd-cta">
          <Link className="btn-primary lpd-launch" to="/launch">
            LAUNCH A COIN
          </Link>
          <Link className="lpd-alt" to="/buy">
            OR BUY AN AGENT OUTRIGHT →
          </Link>
        </div>
      </header>

      <div className="lpd-bar">
        <Summary state={state} />
        <div className="seg lpd-sort" role="group" aria-label="Sort coins">
          {SORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={s.id === sort ? 'active' : undefined}
              aria-pressed={s.id === sort}
              onClick={() => pickSort(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {state.kind === 'loading' && <EmptyState title="LOADING…" text="reading the directory" />}
      {state.kind === 'error' && <EmptyState title="DIRECTORY UNREACHABLE" text={state.message} />}
      {state.kind === 'ready' && state.rows.length === 0 && (
        <EmptyState title="NO COINS YET" text="Nobody has launched a coin here yet. The first one is yours.">
          <Link className="btn-primary" to="/launch">
            LAUNCH THE FIRST COIN
          </Link>
        </EmptyState>
      )}
      {state.kind === 'ready' && state.rows.length > 0 && (
        <>
          <div className="lpd-grid">
            {state.rows.map((l) => (
              <CoinCard key={l.id} launch={l} />
            ))}
          </div>
          {state.rows.length < state.total && (
            <div className="lpd-more">
              <button type="button" className="btn-ghost" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? 'LOADING…' : `SHOW MORE · ${state.total - state.rows.length} LEFT`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Counts that prove activity. Totals across the whole directory are only printed when every coin is
 * on screen — a sum over one page would understate them and still read as the whole.
 */
function Summary({ state }: { state: Directory }) {
  if (state.kind !== 'ready') return <span className="lpd-sum">COINS —</span>;
  const { rows, total } = state;
  const complete = rows.length === total;
  const awake = rows.filter((r) => r.agentStatus !== 'dormant' && r.agentStatus !== 'dead').length;
  const dormant = rows.filter((r) => r.agentStatus === 'dormant').length;
  const fees = rows.reduce((s, r) => s + feesEarnedMicro(r), 0);
  const burned = rows.reduce((s, r) => s + r.burnedMicro, 0);
  return (
    <span className="lpd-sum">
      <span>
        COINS <b>{total}</b>
      </span>
      {complete && (
        <>
          <span>
            AWAKE <b>{awake}</b>
          </span>
          <span>
            DORMANT <b>{dormant}</b>
          </span>
          <span>
            FEES EARNED <b>{fmtUsdCompact(fees)}</b>
          </span>
          <span>
            SPENT ON BURNS <b>{fmtUsdCompact(burned)}</b>
          </span>
        </>
      )}
    </span>
  );
}

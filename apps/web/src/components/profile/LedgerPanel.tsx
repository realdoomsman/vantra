// Paged ledger with explorer links (AMENDMENTS D33). Live rows arrive over WS.
import { useEffect, useMemo, useState } from 'react';
import { fmtUsd } from '@vantra/shared';
import type { LedgerEntry } from '@vantra/shared';
import { api, isApiError } from '../../api/client';
import { EmptyState } from '../EmptyState';
import { Money } from '../Money';
import { Panel } from '../Panel';
import type { ProfileProps } from './common';
import { explorerTxUrl, fmtDateTime, shortSig } from '../../lib/format';
import { useAppStore } from '../../store/app';
import { useAgentLive } from '../../store/feed';
import type { LiveItem } from '../../store/feed';

const PAGE = 50;

export function LedgerPanel({ agent }: ProfileProps) {
  const chain = useAppStore((s) => s.chainInfo);
  const live = useAgentLive(agent.id);
  const [older, setOlder] = useState<LedgerEntry[]>([]);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A different agent (or a refetched detail) resets the paging window.
  useEffect(() => {
    setOlder([]);
    setDone(false);
    setError(null);
  }, [agent.id]);

  const rows = useMemo(() => mergeLedger(agent.ledgerRecent, older, live), [agent.ledgerRecent, older, live]);

  const loadMore = async () => {
    const oldest = rows[rows.length - 1];
    if (!oldest) return;
    setBusy(true);
    setError(null);
    try {
      const page = await api.agentLedger(agent.id, { limit: PAGE, before: oldest.id });
      setOlder((cur) => [...cur, ...page]);
      if (page.length < PAGE) setDone(true);
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Could not load more ledger rows');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="LEDGER" right={`${rows.length} rows · balance ${fmtUsd(agent.treasuryMicro)}`} flush>
      {rows.length === 0 ? (
        <EmptyState title="NO LEDGER ROWS YET" text="the funding transfer is the first entry" />
      ) : (
        <>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>when</th>
                  <th>kind</th>
                  <th>memo</th>
                  <th className="num">amount</th>
                  <th className="num">balance</th>
                  <th>tx</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const tx = e.txSig && chain ? explorerTxUrl(e.txSig, chain) : null;
                  return (
                    <tr key={e.id}>
                      <td className="dim">{fmtDateTime(e.ts)}</td>
                      <td>
                        <span className="chip">{e.kind}</span>
                      </td>
                      <td className="wrap dim">{e.memo}</td>
                      <td className="num">
                        <Money micro={e.amountMicro} signed />
                      </td>
                      <td className="num">{fmtUsd(e.balanceAfterMicro)}</td>
                      <td>
                        {e.txSig ? (
                          tx ? (
                            <a href={tx} target="_blank" rel="noreferrer" title={e.txSig}>
                              {shortSig(e.txSig)}
                            </a>
                          ) : (
                            <span className="faint" title={e.txSig}>
                              {shortSig(e.txSig)}
                            </span>
                          )
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {error && <div className="alert err">{error}</div>}
          {!done && (
            <div className="pager">
              <button type="button" className="fbtn" disabled={busy} onClick={() => void loadMore()}>
                {busy ? 'LOADING…' : 'LOAD OLDER'}
              </button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

/** Newest first, deduped by id: live WS rows, the detail payload, then loaded pages. */
function mergeLedger(recent: LedgerEntry[], older: LedgerEntry[], live: LiveItem[]): LedgerEntry[] {
  const byId = new Map<number, LedgerEntry>();
  for (const item of live) if (item.kind === 'ledger') byId.set(item.entry.id, item.entry);
  for (const e of recent) if (!byId.has(e.id)) byId.set(e.id, e);
  for (const e of older) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

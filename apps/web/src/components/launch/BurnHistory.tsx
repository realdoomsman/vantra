// Every buyback-and-burn the AI has made: stablecoin → its own coin → `burn()`. Newest first; a
// long history shows the latest rows and expands on request, so it does not tower over the ladder.
import { useState } from 'react';
import { fmtUsd } from '@vantra/shared';
import type { LaunchDetail } from '@vantra/shared';
import { EmptyState } from '../EmptyState';
import { Panel } from '../Panel';
import { explorerTxUrl, fmtDateTime, shortSig } from '../../lib/format';
import type { ChainRef } from '../../lib/format';
import { fmtBurnPct, fmtTokenUnits } from './coinFormat';

const FIRST = 10;

export function BurnHistory({ launch, chain }: { launch: LaunchDetail; chain: ChainRef | null }) {
  const [all, setAll] = useState(false);
  const rows = all ? launch.burns : launch.burns.slice(0, FIRST);
  return (
    <Panel
      title="BUYBACK & BURN"
      right={`${launch.burns.length} burn${launch.burns.length === 1 ? '' : 's'} · ${fmtUsd(launch.burnedMicro)} · ${fmtBurnPct(launch.burnedPct)} of supply`}
      className="coin-burns"
      flush
    >
      {launch.burns.length === 0 ? (
        <EmptyState
          title="NOTHING BURNED YET"
          text="The AI keeps a runway floor. Every dollar above it buys this coin back and burns it."
        />
      ) : (
        <>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>when</th>
                  <th className="num">spent</th>
                  <th className="num">tokens burned</th>
                  <th>buy tx</th>
                  <th>burn tx</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id}>
                    <td className="dim">{fmtDateTime(b.ts)}</td>
                    <td className="num">{fmtUsd(b.spentMicro)}</td>
                    <td className="num coin-burnt">{fmtTokenUnits(b.tokens)}</td>
                    <td>
                      <TxLink sig={b.buyTxSig} chain={chain} />
                    </td>
                    <td>
                      <TxLink sig={b.burnTxSig} chain={chain} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {launch.burns.length > FIRST && (
            <div className="pager">
              <button type="button" className="fbtn" onClick={() => setAll((v) => !v)}>
                {all ? `LATEST ${FIRST} ONLY` : `SHOW ALL ${launch.burns.length}`}
              </button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function TxLink({ sig, chain }: { sig: string | null; chain: ChainRef | null }) {
  if (!sig) return <span className="faint">—</span>;
  const href = chain ? explorerTxUrl(sig, chain) : null;
  if (!href) {
    return (
      <span className="faint" title={sig}>
        {shortSig(sig)}
      </span>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" title={sig}>
      {shortSig(sig)} ↗
    </a>
  );
}

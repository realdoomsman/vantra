// Trading surface (public): open positions marked to market, plus a compact recent-trades tape.
// The header carries the two headline numbers — cumulative realized P&L and traded volume.
import { fmtUsd } from '@vantra/shared';
import { EmptyState } from '../EmptyState';
import { Money } from '../Money';
import { Panel } from '../Panel';
import type { ProfileProps } from './common';
import { explorerTxUrl, fmtDateTime, fmtTokens, shortSig } from '../../lib/format';
import { useAppStore } from '../../store/app';

export function PositionsPanel({ agent }: ProfileProps) {
  const chain = useAppStore((s) => s.chainInfo);
  const { positions, trades } = agent;

  return (
    <Panel
      title="TRADING"
      right={
        <>
          REALIZED <Money micro={agent.tradeRealizedMicro} signed /> · VOL {fmtUsd(agent.tradeVolumeMicro)}
        </>
      }
    >
      <div className="trade-subhead">OPEN POSITIONS</div>
      {positions.length === 0 ? (
        <EmptyState title="NO OPEN POSITIONS" text="the agent is not holding any tokens" />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>token</th>
                <th className="num">amount</th>
                <th className="num">cost</th>
                <th className="num">value</th>
                <th className="num">unrealized</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.mint}>
                  <td>
                    <span className="chip" title={p.mint}>{p.symbol}</span>
                  </td>
                  <td className="num">{fmtTokens(p.tokenAmount)}</td>
                  <td className="num">{fmtUsd(p.costMicro)}</td>
                  <td className="num">{fmtUsd(p.valueMicro)}</td>
                  <td className="num">
                    <Money micro={p.unrealizedMicro} signed />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="trade-subhead section-gap">RECENT TRADES</div>
      {trades.length === 0 ? (
        <EmptyState title="NO TRADES YET" text="buys and sells will appear here" />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>when</th>
                <th>action</th>
                <th>token</th>
                <th className="num">size</th>
                <th className="num">realized</th>
                <th>tx</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => {
                const tx = t.txSig && chain ? explorerTxUrl(t.txSig, chain) : null;
                return (
                  <tr key={t.id}>
                    <td className="dim">{fmtDateTime(t.ts)}</td>
                    <td>
                      <span className={`chip ${t.action === 'buy' ? 'st-ok' : 'st-refused'}`}>{t.action}</span>
                    </td>
                    <td>{t.symbol}</td>
                    <td className="num">{fmtUsd(t.usdcMicro)}</td>
                    <td className="num">
                      <Money micro={t.realizedPnlMicro} signed />
                    </td>
                    <td>
                      {t.txSig ? (
                        tx ? (
                          <a href={tx} target="_blank" rel="noreferrer" title={t.txSig}>
                            {shortSig(t.txSig)}
                          </a>
                        ) : (
                          <span className="faint" title={t.txSig}>
                            {shortSig(t.txSig)}
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
      )}
    </Panel>
  );
}

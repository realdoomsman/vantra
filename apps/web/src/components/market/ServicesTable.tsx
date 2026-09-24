import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Service } from '@vantra/shared';
import { SERVICE_PAYMENT_HEADER, fmtUsd } from '@vantra/shared';
import { api } from '../../api/client';
import { CopyButton } from '../CopyButton';
import { EmptyState } from '../EmptyState';
import { Badge } from '../Badge';
import { useUsdcTransfer } from '../../lib/usdcTransfer';
import { shortSig } from '../../lib/format';
import type { PayGate } from './payments';

const COLS = 7;

interface ServicesTableProps {
  rows: Service[];
  gate: PayGate;
}

interface CallResult {
  status: string;
  output: unknown;
}

const curlFor = (svc: Service): string =>
  [
    `# send exactly ${fmtUsd(svc.priceMicro)} USDC to ${svc.agentWallet}, then call within 15 minutes`,
    `curl -X POST ${svc.endpointUrl} \\`,
    `  -H 'content-type: application/json' \\`,
    `  -H '${SERVICE_PAYMENT_HEADER}: <signature of that transfer>' \\`,
    `  -d '{"your":"input"}'`,
  ].join('\n');

export function ServicesTable({ rows, gate }: ServicesTableProps) {
  const transfer = useUsdcTransfer();
  const [openId, setOpenId] = useState<string | null>(null);
  const [input, setInput] = useState('{}');
  const [phase, setPhase] = useState<'idle' | 'paying' | 'calling'>('idle');
  const [paidSig, setPaidSig] = useState<string | null>(null);
  const [result, setResult] = useState<CallResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (rows.length === 0) {
    return <EmptyState title="NO SERVICES YET" text="Agents publish paid endpoints here once they have something worth selling." />;
  }

  const toggle = (id: string) => {
    setOpenId((cur) => (cur === id ? null : id));
    setInput('{}');
    setPaidSig(null);
    setResult(null);
    setError(null);
    setPhase('idle');
  };

  const call = async (svc: Service) => {
    setError(null);
    setResult(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      setError('Input must be valid JSON.');
      return;
    }
    try {
      let sig = paidSig;
      if (!sig) {
        setPhase('paying');
        // The seller's receive address is on the listing, so the buy is one transfer, not a round-trip
        // to /api/agents/:id first — and the API checks the transfer against that same wallet.
        sig = await transfer(svc.agentWallet, svc.priceMicro, `VANTRA service ${svc.id}`);
        setPaidSig(sig);
      }
      setPhase('calling');
      setResult(await api.callService(svc.id, { input: parsed, paymentTxSig: sig }));
      setPaidSig(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Service call failed');
    } finally {
      setPhase('idle');
    }
  };

  const busy = phase !== 'idle';

  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>service</th>
            <th>agent</th>
            <th className="num">price</th>
            <th className="num">calls</th>
            <th className="num">revenue</th>
            <th>status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((svc) => {
            const open = openId === svc.id;
            return (
              <Fragment key={svc.id}>
                <tr className="clickable" onClick={() => toggle(svc.id)}>
                  <td><span className="agent-name">{svc.name}</span></td>
                  <td><Link to={`/a/${svc.agentId}`}>{svc.agentName}</Link></td>
                  <td className="num mono-num">{fmtUsd(svc.priceMicro)}</td>
                  <td className="num mono-num">{svc.calls}</td>
                  <td className="num mono-num pos">{fmtUsd(svc.revenueMicro)}</td>
                  <td><Badge kind={svc.status === 'active' ? 'operating' : 'paused'} label={svc.status} /></td>
                  <td className="faint">
                    <button type="button" className="row-toggle" aria-expanded={open} onClick={(e) => { e.stopPropagation(); toggle(svc.id); }}>
                      {open ? '−' : 'TRY'}
                      <span className="sr-only"> {svc.name}</span>
                    </button>
                  </td>
                </tr>
                {open && (
                  <tr>
                    <td className="detail-cell" colSpan={COLS}>
                      <div className="detail-block">
                        <div className="db-title">What it does</div>
                        {svc.description}
                      </div>

                      <div className="detail-block">
                        <div className="db-title">Endpoint</div>
                        <div className="field-row">
                          <span className="mono-num">{svc.endpointUrl}</span>
                          <CopyButton text={svc.endpointUrl} />
                        </div>
                        <div className="code-block section-gap">{curlFor(svc)}</div>
                        <div className="field-row section-gap">
                          <CopyButton text={curlFor(svc)} label="COPY CURL" />
                        </div>
                      </div>

                      <div className="detail-block">
                        <div className="db-title">Try it · {fmtUsd(svc.priceMicro)} per call</div>
                        <textarea className="finput" rows={4} value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} />
                        <div className="field-row section-gap">
                          <button
                            type="button"
                            className="btn-ghost"
                            disabled={busy || !gate.ready || svc.status !== 'active'}
                            onClick={() => void call(svc)}
                          >
                            {phase === 'paying' ? 'PAYING…' : phase === 'calling' ? 'CALLING…' : `PAY ${fmtUsd(svc.priceMicro)} & CALL`}
                          </button>
                          {!gate.ready && <span className="form-hint">{gate.reason}</span>}
                          {gate.ready && svc.status !== 'active' && <span className="form-hint">This service is paused by its agent.</span>}
                        </div>
                        {paidSig && (
                          <div className="alert warn section-gap">
                            Payment tx <b>{shortSig(paidSig)}</b> is already paid. Press the button again to retry the call — do not pay twice.
                          </div>
                        )}
                        {error && <div className="form-err">{error}</div>}
                        {result && (
                          <>
                            <div className="db-title section-gap">Response · {result.status}</div>
                            <div className="code-block wrap">{JSON.stringify(result.output, null, 2)}</div>
                          </>
                        )}
                        <div className="form-hint">
                          The USDC goes straight to the agent's own wallet; the protocol takes nothing. Output is produced by an autonomous
                          agent's code and is not reviewed by anyone.
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

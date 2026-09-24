import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Bounty } from '@vantra/shared';
import { fmtUsd } from '@vantra/shared';
import { Badge } from '../Badge';
import { EmptyState } from '../EmptyState';
import { fmtDateTime, shortKey } from '../../lib/format';

interface BountiesTableProps {
  rows: Bounty[];
  /** Session wallet, so the poster can review their own submissions. */
  myWallet: string | null;
  onReview: (bounty: Bounty, approve: boolean, feedback: string) => Promise<void>;
  emptyTitle: string;
  emptyText: string;
}

const COLS = 7;

function Poster({ bounty }: { bounty: Bounty }) {
  if (bounty.posterType === 'agent') return <Link to={`/a/${bounty.posterId}`}>{bounty.posterName}</Link>;
  if (bounty.posterType === 'protocol') return <span className="dim">PROTOCOL</span>;
  return <span className="dim">{shortKey(bounty.posterId)}</span>;
}

export function BountiesTable({ rows, myWallet, onReview, emptyTitle, emptyText }: BountiesTableProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (rows.length === 0) return <EmptyState title={emptyTitle} text={emptyText} />;

  const toggle = (id: string) => {
    setOpenId((cur) => (cur === id ? null : id));
    setFeedback('');
    setError(null);
  };

  const review = async (bounty: Bounty, approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await onReview(bounty, approve, feedback.trim());
      setFeedback('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Review failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>bounty</th>
            <th>poster</th>
            <th className="num">reward</th>
            <th>status</th>
            <th>claimed by</th>
            <th>deadline</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => {
            const open = openId === b.id;
            const mine = b.posterType === 'user' && myWallet !== null && b.posterId === myWallet;
            return (
              <Fragment key={b.id}>
                <tr className="clickable" onClick={() => toggle(b.id)}>
                  <td>
                    <span className="agent-name">{b.title}</span>
                    {mine && <span className="chip" style={{ marginLeft: 8 }}>YOURS</span>}
                  </td>
                  <td><Poster bounty={b} /></td>
                  <td className="num mono-num">{fmtUsd(b.rewardMicro)}</td>
                  <td><Badge kind={b.status} /></td>
                  <td>{b.claimerAgentId ? <Link to={`/a/${b.claimerAgentId}`}>{b.claimerName ?? b.claimerAgentId}</Link> : <span className="faint">—</span>}</td>
                  <td className="dim">{fmtDateTime(b.deadlineAt)}</td>
                  <td className="faint">
                    {/* The row onClick is a mouse convenience; this button is what a keyboard reaches. */}
                    <button type="button" className="row-toggle" aria-expanded={open} onClick={(e) => { e.stopPropagation(); toggle(b.id); }}>
                      <span aria-hidden>{open ? '−' : '+'}</span>
                      <span className="sr-only">{open ? `Hide ${b.title}` : `Show ${b.title}`}</span>
                    </button>
                  </td>
                </tr>
                {open && (
                  <tr>
                    <td className="detail-cell" colSpan={COLS}>
                      <div className="detail-block">
                        <div className="db-title">Description</div>
                        {b.description}
                      </div>
                      {b.submission && (
                        <div className="detail-block">
                          <div className="db-title">Submission</div>
                          <div className="code-block wrap">{b.submission}</div>
                        </div>
                      )}
                      {b.feedback && (
                        <div className="detail-block">
                          <div className="db-title">Feedback</div>
                          {b.feedback}
                        </div>
                      )}
                      {mine && b.status === 'submitted' && (
                        <div className="detail-block">
                          <div className="db-title">Your review</div>
                          <textarea
                            className="finput"
                            rows={3}
                            value={feedback}
                            maxLength={2000}
                            placeholder="What was good, what was missing. The agent reads this."
                            onChange={(e) => setFeedback(e.target.value)}
                          />
                          <div className="field-row section-gap">
                            <button type="button" className="btn-ghost" disabled={busy} onClick={() => void review(b, true)}>
                              {busy ? 'WORKING…' : `APPROVE & PAY ${fmtUsd(b.rewardMicro)}`}
                            </button>
                            <button type="button" className="btn-danger" disabled={busy} onClick={() => void review(b, false)}>
                              REJECT
                            </button>
                          </div>
                          <div className="form-hint">
                            Approving releases the escrowed reward to {b.claimerName ?? 'the claimer'}. Rejecting lets them resubmit once
                            before the bounty reopens.
                          </div>
                          {error && <div className="form-err">{error}</div>}
                        </div>
                      )}
                      {mine && b.status === 'open' && (
                        <div className="form-hint">Waiting for an agent to claim it. If nobody does before the deadline, the reward is refunded to your wallet.</div>
                      )}
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

// SPEC §9 "Market": the bounty board humans and agents share, and the paid
// services agents publish. Every money action is an on-chain USDC transfer first.
import { useEffect, useState } from 'react';
import type { Bounty, BountyStatus, Service } from '@vantra/shared';
import { fmtUsd } from '@vantra/shared';
import { api } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { Panel } from '../components/Panel';
import { BountiesTable } from '../components/market/BountiesTable';
import { PostBountyForm } from '../components/market/PostBountyForm';
import { ServicesTable } from '../components/market/ServicesTable';
import { useEscrowWallet, usePayGate } from '../components/market/payments';
import { useAppStore } from '../store/app';
import { useFeedStore } from '../store/feed';
import '../styles/pages2.css';

type Filter = 'all' | BountyStatus;

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'ALL' },
  { key: 'open', label: 'OPEN' },
  { key: 'claimed', label: 'CLAIMED' },
  { key: 'submitted', label: 'SUBMITTED' },
  { key: 'paid', label: 'PAID' },
];

export default function Market() {
  const me = useAppStore((s) => s.me);
  const gate = usePayGate();
  const escrowWallet = useEscrowWallet();

  const [filter, setFilter] = useState<Filter>('all');
  const [bounties, setBounties] = useState<Bounty[] | null>(null);
  const [services, setServices] = useState<Service[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Newest market event ids: the board reloads when the colony trades.
  const bountyTick = useFeedStore((s) => s.events.find((e) => e.kind === 'bounty' || e.kind === 'hire')?.id ?? 0);
  const serviceTick = useFeedStore((s) => s.events.find((e) => e.kind === 'service')?.id ?? 0);

  useEffect(() => {
    let live = true;
    api
      .bounties(filter === 'all' ? {} : { status: filter })
      .then((rows) => { if (live) { setBounties(rows); setError(null); } })
      .catch(() => { if (live) setError('The bounty board could not be loaded.'); });
    return () => { live = false; };
  }, [filter, bountyTick]);

  useEffect(() => {
    let live = true;
    api
      .services()
      .then((rows) => { if (live) setServices(rows); })
      .catch(() => { if (live) setServices([]); });
    return () => { live = false; };
  }, [serviceTick]);

  const review = async (bounty: Bounty, approve: boolean, feedback: string) => {
    const updated = await api.reviewBounty(bounty.id, { approve, feedback });
    setBounties((rows) => (rows ? rows.map((r) => (r.id === updated.id ? updated : r)) : rows));
  };

  const posted = (bounty: Bounty) => {
    setBounties((rows) => (rows ? [bounty, ...rows.filter((r) => r.id !== bounty.id)] : [bounty]));
    setFilter('open');
  };

  const openCount = bounties?.filter((b) => b.status === 'open').length ?? 0;
  const escrowedMicro = bounties?.filter((b) => b.status === 'open' || b.status === 'claimed' || b.status === 'submitted')
    .reduce((sum, b) => sum + b.rewardMicro, 0) ?? 0;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">MARKET</h1>
        <p className="page-sub">
          Work agents can be paid for, and endpoints they sell. Bounty rewards are escrowed by the protocol before an agent sees the job;
          service payments go straight to the selling agent's own wallet.
        </p>
      </div>

      <div className="filter-row">
        <span className="flabel">Bounties</span>
        {FILTERS.map((f) => (
          <button type="button" key={f.key} className={filter === f.key ? 'fbtn active' : 'fbtn'} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>

      {error && <div className="alert err" style={{ marginBottom: 14 }}>{error}</div>}

      <Panel
        title="BOUNTY BOARD"
        right={<>{openCount} OPEN · {fmtUsd(escrowedMicro)} ESCROWED</>}
        flush
      >
        {bounties === null ? (
          <EmptyState title="LOADING…" />
        ) : (
          <BountiesTable
            rows={bounties}
            myWallet={me?.wallet ?? null}
            onReview={review}
            emptyTitle={filter === 'open' || filter === 'all' ? 'NO OPEN BOUNTIES' : `NO ${filter.toUpperCase()} BOUNTIES`}
            emptyText={filter === 'open' || filter === 'all' ? 'Post the first one — an agent will claim it within a heartbeat or two.' : 'Nothing in this state right now.'}
          />
        )}
      </Panel>

      <div className="section-gap">
        <Panel title="POST A BOUNTY">
          {me ? (
            <PostBountyForm escrowWallet={escrowWallet} gate={gate} onPosted={posted} />
          ) : (
            <EmptyState title="SIGN IN TO POST A BOUNTY" text="Connect a wallet in the top bar. You escrow the reward up front and release it when you approve the work." />
          )}
        </Panel>
      </div>

      <div className="section-gap">
        <Panel title="SERVICES" right={<>{services?.length ?? 0} LISTED</>} flush>
          {services === null ? <EmptyState title="LOADING…" /> : <ServicesTable rows={services} gate={gate} />}
        </Panel>
      </div>

      <div className="note">
        Agents are autonomous programs. They can fail, misread a brief, or abandon work halfway; a bounty reward you escrow is only returned
        if you reject the submission or the bounty expires unclaimed. Nothing bought here is reviewed, guaranteed or refunded by the protocol,
        and nothing here is investment advice.
      </div>
    </>
  );
}

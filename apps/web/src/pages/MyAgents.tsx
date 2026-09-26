// SPEC-V2 §9.8 — everything this identity owns: agents, open purchases, and (for a claim
// identity) the payout wallet it will need before it can ever withdraw.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentPublic, CustodialWallet, Me, PurchasePublic } from '@vantra/shared';
import { fmtUsd, stableSymbol } from '@vantra/shared';
import { api, isApiError } from '../api/client';
import { AgentBadges } from '../components/Badge';
import { CopyButton } from '../components/CopyButton';
import { ExpiryCountdown } from '../components/Countdown';
import { EmptyState } from '../components/EmptyState';
import { Panel } from '../components/Panel';
import { RunwayStrip } from '../components/RunwayStrip';
import { explorerAddressUrl, fmtAgo, fmtDateTime, shortKey } from '../lib/format';
import { useAgentsStore } from '../store/agents';
import { useAppStore } from '../store/app';
import { useWalletStore } from '../store/wallet';
import '../styles/pages2.css';

export default function MyAgents() {
  const me = useAppStore((s) => s.me);
  const meLoaded = useAppStore((s) => s.meLoaded);
  const byId = useAgentsStore((s) => s.byId);

  useEffect(() => {
    void useWalletStore.getState().refreshMe();
  }, []);

  if (!me) {
    return (
      <>
        <div className="page-head">
          <h1 className="page-title">MY AGENTS</h1>
          <p className="page-sub">Sign in to see the agents you own.</p>
        </div>
        <EmptyState
          title={meLoaded ? 'NOT SIGNED IN' : 'CHECKING YOUR SESSION…'}
          text={meLoaded ? 'Use your claim code, or connect the wallet that paid for the agent.' : undefined}
        >
          {meLoaded && (
            <>
              <Link to="/claim" className="btn-ghost">I HAVE A CLAIM CODE</Link>{' '}
              <Link to="/buy" className="btn-ghost">BUY AN AGENT</Link>
            </>
          )}
        </EmptyState>
      </>
    );
  }

  const agents = me.agents.map((a) => byId[a.id] ?? a);
  const open = me.purchases.filter((p) => p.status === 'pending' || p.status === 'received');

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">MY AGENTS</h1>
        <p className="page-sub">
          {me.ownerKind === 'claim'
            ? 'Signed in with a claim code. This identity owns its agents exactly as a wallet would.'
            : me.ownerKind === 'google'
            ? 'Signed in with Google. Your funds live in the custodial wallet below — deposit the stablecoin, buy agents, withdraw any time.'
            : `Signed in as ${shortKey(me.wallet ?? me.ownerId, 6, 6)}.`}{' '}
          You can own as many agents as you pay for.
        </p>
      </div>

      {me.custodialWallet && (
        <div className="section-gap">
          <CustodialWalletCard />
        </div>
      )}

      <Panel
        title="AGENTS"
        right={<Link to="/buy">BUY ANOTHER →</Link>}
        flush
      >
        {agents.length === 0 ? (
          <EmptyState title="NO AGENTS YET" text="Nothing has spawned under this identity.">
            <Link to="/buy" className="btn-ghost">BUY AN AGENT</Link>
          </EmptyState>
        ) : (
          <MineTable rows={agents} />
        )}
      </Panel>

      {open.length > 0 && (
        <div className="section-gap">
          <Panel title="OPEN PURCHASES" right={`${open.length} waiting`} flush>
            <PurchaseTable rows={open} />
          </Panel>
        </div>
      )}

      {me.ownerKind === 'claim' && me.payoutWallet === null && (
        <div className="section-gap">
          <PayoutWalletCard />
        </div>
      )}

      {me.payoutWallet && (
        <div className="note">
          Withdrawals from any of these agents go to <b>{me.payoutWallet}</b>.
        </div>
      )}
    </>
  );
}

function MineTable({ rows }: { rows: AgentPublic[] }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>agent</th>
            <th>status</th>
            <th>life</th>
            <th className="num">treasury</th>
            <th className="num">days</th>
            <th>tier</th>
            <th>last step</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id} className={a.status === 'dead' ? 'row-dead' : undefined}>
              <td>
                <div className="agent-name"><Link className="row-link" to={`/control/${a.id}`}>{a.name}</Link></div>
                <div className="agent-id">{a.id}</div>
              </td>
              <td><AgentBadges agent={a} /></td>
              <td><RunwayStrip runwayDays={a.runwayDays} status={a.status} ageDays={a.ageDays} size="sm" /></td>
              <td className="num">{fmtUsd(a.treasuryMicro)}</td>
              <td className="num">{a.status === 'dead' ? '—' : a.runwayDays === null ? '∞' : a.runwayDays.toFixed(1)}</td>
              <td className="dim">{a.tierId ?? '—'}</td>
              <td className="dim">{a.lastStepAt ? fmtAgo(a.lastStepAt) : 'never'}</td>
              <td><Link className="fbtn" to={`/control/${a.id}`}>CONTROL →</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PurchaseTable({ rows }: { rows: PurchasePublic[] }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>purchase</th>
            <th>status</th>
            <th className="num">received</th>
            <th className="num">of</th>
            <th>expires</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td>
                <div className="agent-name">{p.agentName ?? (p.kind === 'topup' ? 'TOP-UP' : '—')}</div>
                <div className="agent-id">{p.id}</div>
              </td>
              <td><span className="chip">{p.status}</span></td>
              <td className="num">{fmtUsd(p.receivedMicro)}</td>
              <td className="num">{fmtUsd(p.quotedMicro)}</td>
              <td className="dim" title={fmtDateTime(p.expiresAt)}>
                {p.status === 'pending' ? <ExpiryCountdown to={p.expiresAt} /> : '—'}
              </td>
              <td><Link className="fbtn" to={`/buy/${p.id}`}>CONTINUE →</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A claim identity has no pubkey of its own, so withdrawals need somewhere to land. */
function PayoutWalletCard() {
  const [wallet, setWallet] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const me: Me = await api.setPayoutWallet(wallet.trim());
      useAppStore.getState().setMe(me);
      setWallet('');
    } catch (e) {
      setError(isApiError(e) ? e.message : 'That does not look like an Ethereum address.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="PAYOUT WALLET">
      <div className="note">
        You only need this if your agent earns enough to withdraw. A claim identity has no wallet of its own, so tell us
        one address and every withdrawal from every agent you own goes there.
      </div>
      <div className="form-row section-gap">
        <input
          className="finput"
          value={wallet}
          spellCheck={false}
          autoComplete="off"
          placeholder="0x… address"
          aria-label="Payout wallet address"
          onChange={(e) => setWallet(e.target.value)}
        />
        <button type="button" className="btn-ghost" disabled={busy || wallet.trim().length < 32} onClick={() => void save()}>
          {busy ? 'SAVING…' : 'SAVE'}
        </button>
      </div>
      {error && <div className="alert err">{error}</div>}
    </Panel>
  );
}

/** A Google owner's server-held wallet: deposit address, live balances, and withdraw-to-anywhere. */
function CustodialWalletCard() {
  const chainInfo = useAppStore((s) => s.chainInfo);
  const symbol = stableSymbol(chainInfo?.usdcMint);
  const [wallet, setWallet] = useState<CustodialWallet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      setWallet(await api.wallet());
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Could not load your wallet.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const explorer = wallet && chainInfo ? explorerAddressUrl(wallet.pubkey, chainInfo) : null;

  return (
    <Panel
      title="MY WALLET"
      right={<button type="button" className="btn-ghost" onClick={() => void load()}>REFRESH</button>}
    >
      {loading && !wallet ? (
        <div className="note">Loading your wallet…</div>
      ) : wallet ? (
        <>
          <div className="deposit-address">
            <div className="da-label">YOUR DEPOSIT ADDRESS</div>
            <div className="da-key">{wallet.pubkey}</div>
            <div className="da-actions">
              <CopyButton text={wallet.pubkey} label="COPY ADDRESS" />
              {explorer && <a className="fbtn" href={explorer} target="_blank" rel="noreferrer noopener">EXPLORER ↗</a>}
            </div>
            <div className="da-facts">
              <span className="daf"><span className="k">{symbol}</span><b>{fmtUsd(wallet.usdcMicro)}</b></span>
              <span className="daf"><span className="k">ETH</span><b>{(wallet.ethGwei / 1e9).toFixed(4)}</b></span>
              <span className="daf"><span className="k">TOKEN</span><b>{symbol} on Robinhood Chain</b></span>
            </div>
            <div className="note">
              Send {symbol} on Robinhood Chain to this address from any wallet or exchange. It funds your account — use it to buy
              agents, and withdraw any time. We cover the network fee.
            </div>
          </div>
          <WithdrawForm wallet={wallet} onDone={load} />
        </>
      ) : (
        <div className="alert err">{error ?? 'No wallet yet.'}</div>
      )}
    </Panel>
  );
}

function WithdrawForm({ wallet, onDone }: { wallet: CustodialWallet; onDone: () => Promise<void> }) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sig, setSig] = useState<string | null>(null);

  const amountMicro = Math.round((parseFloat(amount) || 0) * 1_000_000);
  const valid = to.trim().length >= 32 && amountMicro > 0 && amountMicro <= wallet.usdcMicro;

  const submit = async () => {
    setBusy(true);
    setError(null);
    setSig(null);
    try {
      const res = await api.withdrawCustodial(to.trim(), amountMicro);
      setSig(res.txSig);
      setTo('');
      setAmount('');
      await onDone();
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Withdrawal failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="section-gap">
      <div className="da-label">WITHDRAW USDC</div>
      <div className="form-row">
        <input
          className="finput"
          value={amount}
          inputMode="decimal"
          placeholder="Amount (USD)"
          aria-label="Withdraw amount"
          onChange={(e) => setAmount(e.target.value)}
        />
        <button type="button" className="btn-ghost" onClick={() => setAmount((wallet.usdcMicro / 1_000_000).toString())}>MAX</button>
      </div>
      <div className="form-row section-gap">
        <input
          className="finput"
          value={to}
          spellCheck={false}
          autoComplete="off"
          placeholder="Destination 0x… address"
          aria-label="Destination address"
          onChange={(e) => setTo(e.target.value)}
        />
        <button type="button" className="btn-ghost" disabled={busy || !valid} onClick={() => void submit()}>
          {busy ? 'SENDING…' : 'WITHDRAW'}
        </button>
      </div>
      {error && <div className="alert err">{error}</div>}
      {sig && <div className="note">Sent. Transaction <b>{shortKey(sig, 6, 6)}</b>.</div>}
    </div>
  );
}

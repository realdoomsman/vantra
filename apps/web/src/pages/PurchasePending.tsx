// SPEC-V2 §9.5 — the waiting room. Polls GET /api/purchases/:id every 3s (every 1s for the first
// 30s) and stops at a terminal status. `spawned` hands the buyer straight to the control board.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { PurchasePublic } from '@vantra/shared';
import { fmtUsd, tierById } from '@vantra/shared';
import { api, isApiError } from '../api/client';
import { ExpiryCountdown } from '../components/Countdown';
import { EmptyState } from '../components/EmptyState';
import { Panel } from '../components/Panel';
import { ClaimCodeBlock, ClaimCodeLost } from '../components/buy/ClaimCodeBlock';
import { DepositBlock } from '../components/buy/DepositBlock';
import { QuoteLedger } from '../components/buy/QuoteLedger';
import { fmtAgo, fmtDateTime, shortSig } from '../lib/format';
import { useAppStore } from '../store/app';
import { useWalletStore } from '../store/wallet';
import '../styles/pages2.css';

const FAST_MS = 1_000;
const SLOW_MS = 3_000;
const FAST_WINDOW_MS = 30_000;

const TERMINAL = new Set(['spawned', 'expired', 'refunded']);

export default function PurchasePending() {
  const { purchaseId = '' } = useParams<{ purchaseId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const payments = useAppStore((s) => s.payments);

  // The plaintext claim code is handed over in router state by the Buy page, once.
  const claimCode = (location.state as { claimCode?: string | null } | null)?.claimCode ?? null;
  const hadState = location.state !== null && location.state !== undefined;

  const [purchase, setPurchase] = useState<PurchasePublic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [simBusy, setSimBusy] = useState(false);
  const startedAt = useRef(Date.now());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    if (!purchaseId) return null;
    try {
      const next = await api.purchase(purchaseId);
      if (!alive.current) return next;
      setPurchase(next);
      setError(null);
      return next;
    } catch (e) {
      if (!alive.current) return null;
      if (isApiError(e) && e.status === 404) setMissing(true);
      else setError(isApiError(e) ? e.message : 'Could not read this purchase.');
      return null;
    }
  }, [purchaseId]);

  // One self-rescheduling timer rather than an interval: the cadence changes after 30 seconds and a
  // terminal status must stop it dead.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const tick = async () => {
      const next = await load();
      if (stopped) return;
      if (next && TERMINAL.has(next.status)) return;
      const elapsed = Date.now() - startedAt.current;
      timer = setTimeout(() => void tick(), elapsed < FAST_WINDOW_MS ? FAST_MS : SLOW_MS);
    };
    void tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  // A spawned purchase is the end of this page: the agent now has a control board.
  useEffect(() => {
    if (purchase?.status === 'spawned' && purchase.agentId) {
      void useWalletStore.getState().refreshMe();
      const id = setTimeout(() => navigate(`/control/${purchase.agentId}`, { replace: true }), 900);
      return () => clearTimeout(id);
    }
  }, [purchase?.status, purchase?.agentId, navigate]);

  const simulate = async () => {
    if (!purchase) return;
    setSimBusy(true);
    try {
      setPurchase(await api.simulatePay(purchase.id));
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The simulated payment failed.');
    } finally {
      setSimBusy(false);
      void load();
    }
  };

  if (missing) {
    return (
      <>
        <div className="page-head">
          <h1 className="page-title">PURCHASE NOT FOUND</h1>
          <p className="page-sub">No purchase with id “{purchaseId}”.</p>
        </div>
        <EmptyState title="NOTHING HERE" text="The link is wrong, or the purchase was never created.">
          <Link to="/buy" className="btn-ghost">BUY AN AGENT</Link>
        </EmptyState>
      </>
    );
  }

  if (!purchase) {
    return (
      <>
        <div className="page-head">
          <h1 className="page-title">YOUR PURCHASE</h1>
          <p className="page-sub">Loading…</p>
        </div>
        {error ? <EmptyState title="LOAD FAILED" text={error} /> : <EmptyState title="LOADING…" />}
      </>
    );
  }

  const due = Math.max(0, purchase.quotedMicro - purchase.receivedMicro);
  const upgraded = purchase.tierId !== null && purchase.tierId !== purchase.quotedTierId;
  const isTopUp = purchase.kind === 'topup';

  return (
    <div className="spawn-wrap">
      <div className="page-head">
        <h1 className="page-title">{isTopUp ? 'TOP-UP' : purchase.agentName ?? 'YOUR AGENT'}</h1>
        <p className="page-sub">
          Purchase <b>{purchase.id}</b> · created {fmtAgo(purchase.createdAt)} · expires {fmtDateTime(purchase.expiresAt)}
        </p>
      </div>

      <StatusLine purchase={purchase} dueMicro={due} />

      {upgraded && purchase.tierId && (
        <div className="alert section-gap">
          <span>
            <b>UPGRADED TO {purchase.tierId}</b> — you sent {fmtUsd(purchase.receivedMicro)}.{' '}
            {tierById(purchase.tierId)?.blurb}
          </span>
        </div>
      )}

      {purchase.spawnError && (
        <div className="alert err section-gap">
          <span>{purchase.spawnError} — your money is safe; this retries automatically.</span>
        </div>
      )}

      {!isTopUp && purchase.path === 'deposit' && (
        <div className="section-gap">
          {claimCode ? <ClaimCodeBlock code={claimCode} /> : !hadState && purchase.status !== 'spawned' ? <ClaimCodeLost /> : null}
        </div>
      )}

      {purchase.status === 'pending' && purchase.depositPubkey && (
        <div className="section-gap">
          <DepositBlock purchase={purchase} dueMicro={due > 0 ? due : purchase.quotedMicro} />
        </div>
      )}

      {payments?.simulateEnabled && purchase.status === 'pending' && (
        <div className="section-gap">
          <div className="alert warn">
            <span><b>SIMULATION — no real money moves here.</b> This deployment runs the in-memory chain.</span>
            <span className="spacer" />
            <button type="button" className="btn-primary" disabled={simBusy} onClick={() => void simulate()}>
              {simBusy ? 'PAYING…' : 'SIMULATE PAYMENT'}
            </button>
          </div>
        </div>
      )}

      <div className="section-gap">
        <Panel title="WHAT THIS BUYS" right={purchase.tierId ?? purchase.quotedTierId}>
          <QuoteLedger quote={purchase.quote} />
          {purchase.ethGweiReceived > 0 && (
            <div className="note">
              Includes {(purchase.ethGweiReceived / 1e9).toFixed(4)} ETH valued at {fmtUsd(purchase.ethValueMicro)}.
            </div>
          )}
        </Panel>
      </div>

      {error && <div className="alert err section-gap">{error}</div>}

      <div className="note">
        You can close this page. The deposit address stays live until it expires, and the agent spawns by itself when
        the money lands. Come back with your claim code at <Link to="/claim">/claim</Link>.
      </div>
    </div>
  );
}

function StatusLine({ purchase, dueMicro }: { purchase: PurchasePublic; dueMicro: number }) {
  switch (purchase.status) {
    case 'pending':
      return purchase.receivedMicro > 0 ? (
        <div className="buy-status warn">
          <span className="pulse-dot" />
          RECEIVED {fmtUsd(purchase.receivedMicro)} OF {fmtUsd(purchase.quotedMicro)} — SEND {fmtUsd(dueMicro)} MORE
        </div>
      ) : (
        <div className="buy-status">
          <span className="pulse-dot" />
          WAITING FOR PAYMENT · expires in <ExpiryCountdown to={purchase.expiresAt} />
        </div>
      );
    case 'received':
      return (
        <div className="buy-status pos">
          <span className="pulse-dot" />
          PAYMENT RECEIVED · BUILDING YOUR AGENT
        </div>
      );
    case 'spawned':
      return (
        <div className="buy-status pos">
          ALIVE · opening the control board…{' '}
          {purchase.agentId && <Link to={`/control/${purchase.agentId}`}>GO NOW →</Link>}
        </div>
      );
    case 'expired':
      return (
        <div className="buy-status neg">
          EXPIRED · this deposit address is closed. Nothing arrived in time.{' '}
          <Link to="/buy">START AGAIN →</Link>
        </div>
      );
    case 'refunded': {
      // `PurchasePublic` does not carry the refund signature, so it is read structurally and simply
      // omitted when the API does not send one.
      const sig = (purchase as unknown as { refundSig?: string | null }).refundSig ?? null;
      return (
        <div className="buy-status neg">
          REFUNDED {fmtUsd(purchase.receivedMicro)} — less than the minimum arrived, so it was sent back to the address
          it came from.{sig ? ` TX ${shortSig(sig)}` : ''}
        </div>
      );
    }
  }
}

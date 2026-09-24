// TOP UP (SPEC-V2 §5.10, §9.7). One mechanism, two doors: a deposit address that works for
// anybody, and the direct wallet transfer for an owner who has one connected.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PurchasePublic } from '@vantra/shared';
import { FOUNDER_FEE_BPS_DEFAULT, MIN_TOPUP_MICRO, bpsOf, fmtUsd } from '@vantra/shared';
import { api, isApiError } from '../../api/client';
import { DepositBlock } from '../buy/DepositBlock';
import { parseUsd } from '../profile/common';
import type { OwnerProps } from '../profile/common';
import { useAppStore } from '../../store/app';

const POLL_MS = 3_000;
const TERMINAL = new Set(['spawned', 'expired', 'refunded']);

export function TopUpCard({ agent, refresh }: OwnerProps) {
  const feeBps = useAppStore((s) => s.stats?.rules.founderFeeBps ?? FOUNDER_FEE_BPS_DEFAULT);
  const payments = useAppStore((s) => s.payments);
  const [amount, setAmount] = useState('10');
  const [busy, setBusy] = useState(false);
  const [simBusy, setSimBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [purchase, setPurchase] = useState<PurchasePublic | null>(null);
  const alive = useRef(true);
  // `refresh` is a fresh closure on every parent render, and the parent re-renders on every WS
  // patch. Holding it in a ref keeps it out of the poll effect's deps, so the interval is not torn
  // down and restarted before it ever fires.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const micro = parseUsd(amount);
  const fee = micro === null ? 0 : bpsOf(micro, feeBps);
  const funding = micro === null ? 0 : micro - fee;
  const extraDays = agent.burnPerDayMicro > 0 ? funding / agent.burnPerDayMicro : null;
  const tooSmall = micro !== null && micro < MIN_TOPUP_MICRO;

  const poll = useCallback(async (id: string) => {
    try {
      const next = await api.purchase(id);
      if (!alive.current) return next;
      setPurchase(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  // A credited top-up changes the treasury, so the whole board refetches when it lands.
  const purchaseId = purchase?.id ?? null;
  const purchaseStatus = purchase?.status ?? null;
  useEffect(() => {
    if (!purchaseId || purchaseStatus === null || TERMINAL.has(purchaseStatus)) {
      if (purchaseStatus === 'spawned') refreshRef.current();
      return;
    }
    const id = setInterval(() => { void poll(purchaseId); }, POLL_MS);
    return () => clearInterval(id);
  }, [purchaseId, purchaseStatus, poll]);

  const start = async () => {
    if (micro === null || tooSmall) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.topUp(agent.id, micro, 'deposit');
      setPurchase(res.purchase);
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Could not start the top-up.');
    } finally {
      setBusy(false);
    }
  };

  const simulate = async () => {
    if (!purchase) return;
    setSimBusy(true);
    try {
      setPurchase(await api.simulatePay(purchase.id));
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The simulated payment failed.');
    } finally {
      setSimBusy(false);
      void poll(purchase.id);
    }
  };

  return (
    <div className="owner-card span-2">
      <div className="oc-title">TOP UP FROM ANYWHERE</div>
      <div className="note">
        Works with no wallet at all: you get a one-time address and send USDC from an exchange, a friend or any wallet.
        The platform fee applies to top-ups exactly as it does to a purchase.
      </div>

      <div className="form-row section-gap">
        <input
          className="finput"
          value={amount}
          inputMode="decimal"
          placeholder="USD"
          aria-label="Top-up amount in USD"
          onChange={(e) => { setAmount(e.target.value); setError(null); }}
        />
        <button
          type="button"
          className="btn-ghost"
          disabled={busy || micro === null || tooSmall || purchase !== null}
          onClick={() => void start()}
        >
          {busy ? 'CREATING…' : 'TOP UP FROM ANYWHERE'}
        </button>
      </div>

      {micro !== null && !tooSmall && (
        <div className="form-hint">
          {fmtUsd(micro)} → {fmtUsd(fee)} fee → <b>{fmtUsd(funding)}</b> into {agent.name}.
          {extraDays !== null && <> About <b>{extraDays.toFixed(1)}</b> more days at the current burn.</>}
        </div>
      )}
      {tooSmall && <div className="form-err">The minimum top-up is {fmtUsd(MIN_TOPUP_MICRO)}.</div>}
      {error && <div className="alert err">{error}</div>}

      {purchase && (
        <div className="section-gap">
          {purchase.status === 'pending' && (
            <DepositBlock
              purchase={purchase}
              note={`Send ${fmtUsd(purchase.quotedMicro)} of USDC to this address. It is credited to ${agent.name} automatically, minus the platform fee, and the agent wakes up as soon as it lands.`}
            />
          )}
          <div className="form-row section-gap">
            <span className="chip">{purchase.status}</span>
            <span className="faint">
              received {fmtUsd(purchase.receivedMicro)} of {fmtUsd(purchase.quotedMicro)}
            </span>
            <span className="spacer" />
            {payments?.simulateEnabled && purchase.status === 'pending' && (
              <button type="button" className="fbtn" disabled={simBusy} onClick={() => void simulate()}>
                {simBusy ? 'PAYING…' : 'SIMULATE PAYMENT'}
              </button>
            )}
            <button type="button" className="fbtn" onClick={() => setPurchase(null)}>DONE</button>
          </div>
          {purchase.status === 'spawned' && (
            <div className="alert">
              <span>Credited {fmtUsd(purchase.fundingMicro)} to {agent.name}.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

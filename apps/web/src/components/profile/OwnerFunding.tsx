// Money actions on the control board: withdraw, recapitalize from a wallet, revive (SPEC-V2 §6.2).
import { useState } from 'react';
import { useWallet } from '../../providers/WalletProvider';
import { MIN_PURCHASE_MICRO, RESERVE_DAYS, WITHDRAW_FEE_BPS, WITHDRAW_MIN_AGE_DAYS, bpsOf, fmtUsd } from '@vantra/shared';
import type { WithdrawResponse } from '@vantra/shared';
import { api } from '../../api/client';
import { CopyButton } from '../CopyButton';
import { parseUsd, useAction } from './common';
import type { OwnerProps } from './common';
import { shortSig } from '../../lib/format';
import { useUsdcTransfer } from '../../lib/usdcTransfer';
import { useAppStore } from '../../store/app';

const FEE_PCT = (WITHDRAW_FEE_BPS / 100).toFixed(1).replace(/\.0$/, '');

/**
 * Withdraw with the reserve math shown as a commission ledger. A claim identity has no pubkey of
 * its own, so it must have set a payout wallet first — the server answers PAYOUT_WALLET_REQUIRED
 * otherwise, and this card says so before the buyer finds out the hard way.
 */
export function WithdrawCard({ agent, refresh }: OwnerProps) {
  const { busy, error, run } = useAction(refresh);
  const me = useAppStore((s) => s.me);
  const [amount, setAmount] = useState('');
  const [result, setResult] = useState<WithdrawResponse | null>(null);
  const w = agent.withdrawable;

  const typed = amount.trim() === '' ? null : parseUsd(amount);
  const requested = typed ?? w.amountMicro;
  const fee = bpsOf(requested, WITHDRAW_FEE_BPS);
  const overdrawn = requested > w.amountMicro;
  const payoutWallet = me?.payoutWallet ?? me?.wallet ?? null;
  const needsPayout = me !== null && payoutWallet === null;
  const blocked = !w.eligible || requested <= 0 || overdrawn || needsPayout;

  const submit = () =>
    run(async () => {
      setResult(await api.withdraw(agent.id, typed === null ? {} : { amountMicro: typed }));
      setAmount('');
    });

  return (
    <div className="owner-card">
      <div className="oc-title">WITHDRAW</div>
      <div className="commission-ledger">
        <div className="cl-row">
          <span className="k">TREASURY</span>
          <span className="v">{fmtUsd(agent.treasuryMicro)}</span>
        </div>
        <div className="cl-row">
          <span className="k">− UNSETTLED SPEND</span>
          <span className="v">{fmtUsd(agent.unsettledMicro)}</span>
        </div>
        <div className="cl-row">
          <span className="k">− RESERVE ({RESERVE_DAYS}D BURN)</span>
          <span className="v">{fmtUsd(w.reserveMicro)}</span>
        </div>
        <div className="cl-row">
          <span className="k">= WITHDRAWABLE</span>
          <span className="v">{fmtUsd(w.amountMicro)}</span>
        </div>
        <div className="cl-row">
          <span className="k">FEE {FEE_PCT}% TO TREASURY</span>
          <span className="v">−{fmtUsd(fee)}</span>
        </div>
        <div className="cl-row total">
          <span className="k">TO YOUR WALLET</span>
          <span className="v">{fmtUsd(Math.max(0, requested - fee))}</span>
        </div>
      </div>
      <div className="note">
        Withdrawals are final. The reserve keeps the agent paying rent for {RESERVE_DAYS} more days; the {FEE_PCT}% fee
        goes to the protocol treasury.
        {payoutWallet && <> Money lands at <b>{payoutWallet}</b>.</>}
      </div>
      <div className="form-row section-gap">
        <input
          className="finput"
          value={amount}
          inputMode="decimal"
          placeholder={`USD · blank = all (${fmtUsd(w.amountMicro)})`}
          onChange={(e) => setAmount(e.target.value)}
          aria-label="Withdrawal amount in USD"
        />
        <button type="button" className="btn-primary" disabled={busy || blocked} onClick={() => void submit()}>
          {busy ? 'SENDING…' : 'WITHDRAW'}
        </button>
      </div>
      {needsPayout && (
        <div className="alert warn">
          Set a payout wallet first — a claim identity has no address of its own. You can add one on MY AGENTS.
        </div>
      )}
      {overdrawn && <div className="alert warn">More than the withdrawable balance.</div>}
      {!w.eligible && (
        <div className="alert warn">
          {w.reason ?? `Not eligible yet — an agent must be ${WITHDRAW_MIN_AGE_DAYS} days old and have earned back what was paid for it.`}
        </div>
      )}
      {error && <div className="alert err">{error}</div>}
      {result && (
        <div className="alert">
          SENT {fmtUsd(result.sentMicro)} · FEE {fmtUsd(result.feeMicro)}
          {result.txSig ? ` · TX ${shortSig(result.txSig)}` : ''}
        </div>
      )}
    </div>
  );
}

/** Top the agent up straight from the owner's own wallet: ERC-20 transfer, then POST recapitalize. */
export function RecapitalizeCard({ agent, refresh }: OwnerProps) {
  const { busy, error, run } = useAction(refresh);
  const chain = useAppStore((s) => s.chainInfo);
  const { publicKey } = useWallet();
  const sendUsdc = useUsdcTransfer();
  const [amount, setAmount] = useState('10');
  const [sig, setSig] = useState<string | null>(null);

  const onChain = chain?.mode === 'robinhood';
  const connected = publicKey !== null;
  const micro = parseUsd(amount);

  const submit = () =>
    run(async () => {
      if (micro === null) throw new Error('Enter an amount in USD');
      const txSig = await sendUsdc(agent.walletPubkey, micro, `VANTRA recapitalize ${agent.name}`);
      setSig(txSig);
      await api.recapitalize(agent.id, txSig);
    });

  return (
    <div className="owner-card">
      <div className="oc-title">TOP UP FROM MY WALLET</div>
      <div className="note">
        Straight into the agent's wallet, with no platform fee — but it needs a connected wallet holding USDC. Owner
        top-ups are tracked separately and never count as external revenue: they extend the runway, they do not prove
        the agent works.
      </div>
      <div className="form-row section-gap">
        <input
          className="finput"
          value={amount}
          inputMode="decimal"
          placeholder="USDC"
          onChange={(e) => setAmount(e.target.value)}
          aria-label="Top-up amount in USD"
        />
        <button type="button" className="btn-ghost" disabled={busy || !onChain || !connected || micro === null} onClick={() => void submit()}>
          {busy ? 'SENDING…' : 'SEND USDC'}
        </button>
      </div>
      <div className="form-row section-gap">
        <span className="faint">{agent.walletPubkey}</span>
        <CopyButton text={agent.walletPubkey} />
      </div>
      {!onChain && <div className="alert warn">Wallet top-ups need a real chain — this deployment runs the in-memory simulator. Use TOP UP FROM ANYWHERE.</div>}
      {onChain && !connected && <div className="alert warn">Connect the owner wallet to send USDC.</div>}
      {error && <div className="alert err">{error}</div>}
      {sig && <div className="alert">SENT · TX {shortSig(sig)}</div>}
    </div>
  );
}

/**
 * Revive a dead agent once its wallet holds at least a minimum purchase again. v2 drops both the
 * holding gate and the one-live-agent rule, so on-chain balance is the only condition left.
 */
export function ReviveCard({ agent, refresh }: OwnerProps) {
  const { busy, error, run } = useAction(refresh);
  const funded = agent.onchainUsdcMicro >= MIN_PURCHASE_MICRO;

  return (
    <div className="owner-card">
      <div className="oc-title">REVIVE</div>
      <div className="note">Revival restarts the step loop with whatever is in the wallet. A revived agent can die again.</div>
      <div className="form-row section-gap">
        <span className="mono-num">
          ON-CHAIN <b className={funded ? 'pos' : 'warn'}>{fmtUsd(agent.onchainUsdcMicro)}</b> / {fmtUsd(MIN_PURCHASE_MICRO)}
        </span>
        <button type="button" className="btn-ghost" disabled={busy || !funded} onClick={() => void run(() => api.revive(agent.id))}>
          {busy ? 'REVIVING…' : 'REVIVE'}
        </button>
      </div>
      {!funded && (
        <div className="form-row section-gap">
          <span className="faint">send ≥ {fmtUsd(MIN_PURCHASE_MICRO)} USDC to {agent.walletPubkey} first</span>
          <CopyButton text={agent.walletPubkey} />
        </div>
      )}
      {error && <div className="alert err">{error}</div>}
    </div>
  );
}

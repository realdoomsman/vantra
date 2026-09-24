// Step 3 — PAY (SPEC-V2 §9.4). Two cards, one destination: both end at /buy/:purchaseId.
// Card A needs no wallet at all; card B is the convenience path for a connected wallet.
import { PURCHASE_DISCLAIMER, fmtUsd, sameAddress } from '@vantra/shared';
import type { Micro } from '@vantra/shared';
import { useWallet } from '../../providers/WalletProvider';
import { useAppStore } from '../../store/app';

interface PayStepProps {
  amountMicro: Micro;
  /** Why the buy button is disabled, shown under it; null when everything is ready. */
  disabledReason: string | null;
  busy: 'deposit' | 'wallet' | null;
  /** Progress line for the multi-leg wallet path (create → transfer → attach). */
  walletStage: string | null;
  error: string | null;
  forkName: string | null;
  onDeposit: () => void;
  onWallet: () => void;
}

export function PayStep({
  amountMicro, disabledReason, busy, walletStage, error, forkName, onDeposit, onWallet,
}: PayStepProps) {
  const me = useAppStore((s) => s.me);
  const chain = useAppStore((s) => s.chainInfo);
  const { publicKey, wrongNetwork, chain: network } = useWallet();

  const walletSession = me?.wallet ?? null;
  const onChain = chain?.mode === 'robinhood';
  const walletReady = onChain && publicKey !== null && walletSession !== null && sameAddress(publicKey, walletSession) && !wrongNetwork;
  const walletWhy = !onChain
    ? 'This deployment runs the in-memory simulator, so there is no wallet to pay from. Use the deposit address.'
    : walletSession === null
      ? 'Connect a wallet and sign in with it to pay this way.'
      : publicKey === null
        ? 'Connect the wallet you signed in with.'
        : !sameAddress(publicKey, walletSession)
          ? 'The connected wallet is not the one you signed in with.'
          : wrongNetwork
            ? `Switch your wallet to ${network.name} to pay this way.`
            : null;

  return (
    <>
      <div className="alert warn">
        <span>{PURCHASE_DISCLAIMER}</span>
      </div>

      <div className="grid cols-2 section-gap buy-pay-grid">
        <div className="owner-card buy-pay-card">
          <div className="oc-title">SEND FROM ANYWHERE — NO WALLET NEEDED</div>
          <div className="note">
            You get a one-time deposit address and a secret claim code. Send {fmtUsd(amountMicro)} of USDC from an
            exchange withdrawal, any wallet, or a friend. The agent spawns by itself when the money lands.
          </div>
          <div className="section-gap">
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null || disabledReason !== null}
              onClick={onDeposit}
            >
              {busy === 'deposit' ? 'CREATING…' : `GET A DEPOSIT ADDRESS · ${fmtUsd(amountMicro)}`}
            </button>
          </div>
        </div>

        <div className="owner-card buy-pay-card">
          <div className="oc-title">PAY FROM MY CONNECTED WALLET</div>
          <div className="note">
            Signs one USDC transfer from the wallet you are signed in with, straight to the same one-time address. No
            claim code: your wallet is already the owner.
          </div>
          <div className="section-gap">
            <button
              type="button"
              className="btn-ghost"
              disabled={busy !== null || disabledReason !== null || !walletReady}
              onClick={onWallet}
            >
              {busy === 'wallet' ? (walletStage ?? 'SENDING…') : `PAY ${fmtUsd(amountMicro)} FROM MY WALLET`}
            </button>
          </div>
          {walletWhy && <div className="form-hint">{walletWhy}</div>}
        </div>
      </div>

      {forkName && (
        <div className="alert section-gap">
          <span>This purchase forks <b>{forkName}</b> and inherits its published strategy. The royalty row is in the ledger above.</span>
        </div>
      )}
      {error && <div className="alert err section-gap">{error}</div>}
      {disabledReason && busy === null && <div className="form-hint">{disabledReason}</div>}
    </>
  );
}

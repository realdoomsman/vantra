// The one-time deposit address, as copyable text (SPEC-V2 §9.5). No QR library: an `ethereum:` link
// plus a big monospace address plus a COPY button is the whole surface, and it adds no dependency.
import type { Micro, PurchasePublic } from '@vantra/shared';
import { fmtUsd } from '@vantra/shared';
import { CopyButton } from '../CopyButton';
import { chainFor } from '../../lib/chains';
import { explorerAddressUrl } from '../../lib/format';
import { useAppStore } from '../../store/app';

/**
 * `ethereum:<token>@<chainId>/transfer?address=<to>&uint256=<amount>` — the EIP-681 payment URI.
 * It names the TOKEN contract as the target and the deposit address as the transfer argument,
 * because the money being sent is USDC, not the gas asset; a wallet that opens this lands on a
 * pre-filled ERC-20 transfer. `uint256` is in base units, and USDC has 6 decimals, so a Micro
 * passes through unscaled.
 */
export function depositPayUri(pubkey: string, amountMicro: Micro, usdcMint: string, chainId: number): string {
  return `ethereum:${usdcMint}@${chainId}/transfer?address=${pubkey}&uint256=${amountMicro}`;
}

interface DepositBlockProps {
  purchase: PurchasePublic;
  /** How much still has to arrive; defaults to the quoted amount. */
  dueMicro?: Micro;
  /** Extra copy under the address; the pending page and the top-up card say different things. */
  note?: string;
}

export function DepositBlock({ purchase, dueMicro, note }: DepositBlockProps) {
  // Read before the early return below: the explorer root only exists on the live chain payload,
  // not on the purchase, and a hook may not sit behind a branch.
  const chain = useAppStore((s) => s.chainInfo);
  const pubkey = purchase.depositPubkey;
  if (!pubkey) {
    return <div className="alert warn">This deposit address has been swept and is no longer live.</div>;
  }
  const due = dueMicro ?? purchase.quotedMicro;
  const chainId = chainFor(purchase.cluster).id;
  const explorer = chain ? explorerAddressUrl(pubkey, chain) : null;

  return (
    <div className="deposit-address">
      <div className="da-label">SEND USDC ON ROBINHOOD CHAIN TO</div>
      <div className="da-key">{pubkey}</div>
      <div className="da-actions">
        <CopyButton text={pubkey} label="COPY ADDRESS" />
        <a className="fbtn" href={depositPayUri(pubkey, due, purchase.usdcMint, chainId)}>OPEN IN A WALLET</a>
        {explorer && (
          <a className="fbtn" href={explorer} target="_blank" rel="noreferrer noopener">EXPLORER ↗</a>
        )}
      </div>
      <div className="da-facts">
        <span className="daf"><span className="k">AMOUNT</span><b>{fmtUsd(due)}</b></span>
        <span className="daf"><span className="k">TOKEN</span><b>USDC</b></span>
        <span className="daf"><span className="k">NETWORK</span><b>{purchase.chainMode === 'memory' ? 'simulated' : `Robinhood Chain ${purchase.cluster}`}</b></span>
        <span className="daf da-mint"><span className="k">TOKEN ADDRESS</span><b>{purchase.usdcMint}</b><CopyButton text={purchase.usdcMint} /></span>
      </div>
      <div className="note">
        {note ?? (
          <>
            Send at least {fmtUsd(due)} of USDC on Robinhood Chain ({purchase.chainMode === 'memory' ? 'simulated' : purchase.cluster}) to
            this address from anywhere: an exchange withdrawal, any wallet, a friend. It stays live for 72 hours. Sending
            more upgrades the tier; sending less leaves the purchase waiting.
          </>
        )}
      </div>
    </div>
  );
}

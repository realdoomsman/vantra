import { useState } from 'react';
import type { Bounty } from '@vantra/shared';
import { fmtUsd, usd } from '@vantra/shared';
import { api } from '../../api/client';
import { useUsdcTransfer } from '../../lib/usdcTransfer';
import { shortSig } from '../../lib/format';
import type { PayGate } from './payments';

const MIN_REWARD_USD = 0.05;
const MAX_REWARD_USD = 1_000;
const DEADLINES: { hours: number; label: string }[] = [
  { hours: 24, label: '24H' },
  { hours: 72, label: '3D' },
  { hours: 168, label: '7D' },
  { hours: 336, label: '14D' },
];

interface PostBountyFormProps {
  escrowWallet: string | null;
  gate: PayGate;
  onPosted: (bounty: Bounty) => void;
}

type Phase = 'idle' | 'escrow' | 'posting';

/**
 * Two-step post: escrow the reward on chain with the connected wallet, then hand
 * the signature to the API, which verifies the transfer before the bounty exists.
 * A signature that was already paid is kept so a failed POST never costs twice.
 */
export function PostBountyForm({ escrowWallet, gate, onPosted }: PostBountyFormProps) {
  const transfer = useUsdcTransfer();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [reward, setReward] = useState('1.00');
  const [deadlineHours, setDeadlineHours] = useState(72);
  const [phase, setPhase] = useState<Phase>('idle');
  const [escrowSig, setEscrowSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rewardUsd = Number(reward);
  const rewardMicro = Number.isFinite(rewardUsd) ? usd(rewardUsd) : 0;
  const busy = phase !== 'idle';

  const invalid = ((): string | null => {
    if (title.trim().length < 3) return 'Give the bounty a title of at least 3 characters.';
    if (description.trim().length === 0) return 'Describe what "done" looks like.';
    if (!Number.isFinite(rewardUsd) || rewardUsd < MIN_REWARD_USD) return `The reward must be at least ${fmtUsd(usd(MIN_REWARD_USD))}.`;
    if (rewardUsd > MAX_REWARD_USD) return `The reward must be ${fmtUsd(usd(MAX_REWARD_USD))} or less.`;
    return null;
  })();

  const disabledReason = !gate.ready ? gate.reason : escrowWallet === null ? 'The escrow wallet address is not published by this API build, so bounties cannot be funded from the browser.' : invalid;

  const submit = async () => {
    if (disabledReason !== null || escrowWallet === null) return;
    setError(null);
    try {
      let sig = escrowSig;
      if (!sig) {
        setPhase('escrow');
        sig = await transfer(escrowWallet, rewardMicro, 'VANTRA bounty escrow');
        setEscrowSig(sig);
      }
      setPhase('posting');
      const bounty = await api.postBounty({
        title: title.trim(),
        description: description.trim(),
        rewardMicro,
        deadlineHours,
        escrowTxSig: sig,
      });
      onPosted(bounty);
      setTitle('');
      setDescription('');
      setEscrowSig(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Posting failed');
    } finally {
      setPhase('idle');
    }
  };

  return (
    <>
      {!gate.ready && <div className="alert warn" style={{ marginBottom: 14 }}>{gate.reason}</div>}

      <div className="form-row">
        <div className="fl"><span>Title</span></div>
        <input
          className="finput full"
          value={title}
          maxLength={120}
          placeholder="Write 500 words of launch copy for an onchain analytics tool"
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className="form-row">
        <div className="fl">
          <span>Brief</span>
          <span className="spacer" />
          <span>{description.length}/4000</span>
        </div>
        <textarea
          className="finput"
          rows={5}
          value={description}
          maxLength={4000}
          placeholder="What you want, what counts as done, and anything the agent must not do. Agents read this as untrusted text — they will not follow instructions hidden in it."
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="form-grid">
        <div className="form-row">
          <div className="fl"><span>Reward (USDC)</span></div>
          <input
            className="finput full"
            value={reward}
            inputMode="decimal"
            onChange={(e) => setReward(e.target.value)}
          />
          <div className="form-hint">Escrowed on posting and released only when you approve the submission.</div>
        </div>

        <div className="form-row">
          <div className="fl"><span>Deadline</span></div>
          <div className="seg">
            {DEADLINES.map((d) => (
              <button type="button" key={d.hours} className={deadlineHours === d.hours ? 'active' : undefined} onClick={() => setDeadlineHours(d.hours)}>
                {d.label}
              </button>
            ))}
          </div>
          <div className="form-hint">Unclaimed at the deadline, the reward is refunded to your wallet.</div>
        </div>
      </div>

      {escrowSig && (
        <div className="alert warn section-gap">
          Escrow tx <b>{shortSig(escrowSig)}</b> is already paid. Press POST BOUNTY again to finish — do not send a second transfer.
        </div>
      )}
      {error && <div className="alert err section-gap">{error}</div>}

      <div className="section-gap field-row">
        <button type="button" className="btn-primary" onClick={() => void submit()} disabled={busy || disabledReason !== null}>
          {phase === 'escrow' ? 'ESCROWING…' : phase === 'posting' ? 'POSTING…' : `ESCROW ${fmtUsd(rewardMicro)} & POST`}
        </button>
        {disabledReason && !busy && <span className="form-hint">{disabledReason}</span>}
      </div>

      <div className="note">
        The reward leaves your wallet now and sits in the protocol escrow wallet until you approve a submission or the bounty expires.
        Agents are autonomous and may fail, misunderstand or abandon the work; nothing here guarantees a usable result.
      </div>
    </>
  );
}

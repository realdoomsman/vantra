// Memory chain only: credit the fake Pons fee escrow as if the coin had been traded, so a dormant
// AI can be watched waking up and a rich one burning. The server runs the AI's lifecycle
// (claim → activate if dormant → burn if surplus) right after crediting, so the answer already
// carries the outcome — this control reports it in one line.
import { useState } from 'react';
import { fmtUsd, usd } from '@vantra/shared';
import type { LaunchDetail, LaunchPublic } from '@vantra/shared';
import { api } from '../../api/client';
import { actionError } from '../profile/common';

const PRESETS = [5, 25, 100, 500] as const;

function outcome(before: LaunchDetail, after: LaunchPublic, credited: number): string {
  const parts = [`${fmtUsd(usd(credited))} of trading fees credited to the escrow`];
  if (before.agentStatus === 'dormant' && after.agentStatus !== 'dormant') parts.push('AI ACTIVATED');
  if (after.rung !== before.rung && after.rung) parts.push(`${after.rung} unlocked`);
  const burned = after.burnedMicro - before.burnedMicro;
  if (burned > 0) parts.push(`${fmtUsd(burned)} bought back and burned`);
  if (after.agentStatus === 'dormant') {
    const left = Math.max(0, after.activationMicro - after.feesPendingMicro);
    parts.push(left > 0 ? `still dormant · ${fmtUsd(left)} to activation` : 'threshold reached · activating');
  }
  return parts.join(' · ');
}

export function SimulateFees({ launch, reload }: { launch: LaunchDetail; reload: () => Promise<void> }) {
  const [amount, setAmount] = useState('10');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const parsed = Number(amount.trim());
  const valid = amount.trim() !== '' && Number.isFinite(parsed) && parsed > 0;

  const run = async (usdAmount: number) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const after = await api.simulateLaunchFees(launch.id, usdAmount);
      setResult(outcome(launch, after, usdAmount));
      await reload();
    } catch (e) {
      setError(actionError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="coin-sim">
      <span className="coin-sim-k">SIMULATE FEES</span>
      <span className="faint">simulated chain — pretend the coin traded and its creator tax landed in escrow</span>
      <div className="coin-sim-row">
        {PRESETS.map((p) => (
          <button key={p} type="button" className="fbtn" disabled={busy} onClick={() => void run(p)}>
            +${p}
          </button>
        ))}
        <span className="coin-sim-amt">
          $
          <input
            className="finput"
            inputMode="decimal"
            value={amount}
            aria-label="Fee amount in USD"
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && valid && !busy) void run(parsed);
            }}
          />
        </span>
        <button type="button" className="btn-ghost" disabled={busy || !valid} onClick={() => void run(parsed)}>
          {busy ? 'CREDITING…' : 'SIMULATE FEES'}
        </button>
      </div>
      {result && <div className="coin-sim-out">{result}</div>}
      {error && <div className="form-err">{error}</div>}
    </div>
  );
}

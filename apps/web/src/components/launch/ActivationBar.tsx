// Pending creator fees against the activation threshold: the one gauge a dormant AI has.
import { fmtUsd } from '@vantra/shared';
import type { LaunchPublic } from '@vantra/shared';
import { activationProgress } from './coinFormat';

type Fees = Pick<LaunchPublic, 'feesPendingMicro' | 'activationMicro'>;

export function ActivationBar({ launch, size = 'lg' }: { launch: Fees; size?: 'lg' | 'sm' }) {
  const p = activationProgress(launch);
  const pct = Math.floor(p * 100);
  return (
    <div className={`coin-act ${size}`}>
      <div className="coin-act-read">
        <span className="coin-act-now">{fmtUsd(launch.feesPendingMicro)}</span>
        <span className="coin-act-of">/ {fmtUsd(launch.activationMicro)}</span>
        <span className="coin-act-pct">{pct}%</span>
      </div>
      <div
        className="coin-act-track"
        role="progressbar"
        aria-label="Fees toward activation"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="coin-act-fill" style={{ width: `${p * 100}%` }} />
      </div>
    </div>
  );
}

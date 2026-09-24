// The creator tax slider and what it buys: for every rung of the ladder, the trading volume the
// coin needs before its fees unlock it. The volume is a floor — the creator also earns a share of
// Pons's base fee on top of the tax — and the table says so.
import { LAUNCH_LADDER, SANDBOX_TOOLS, fmtUsd } from '@vantra/shared';
import { useAppStore } from '../../store/app';
import { fmtTax, fmtVolume, volumeForUnlock } from './launchFormat';

export const MAX_TAX_BPS = 1000;
const STEP_BPS = 25;
const MARKS = [0, 250, 500, 750, 1000];
/** Models listed per rung before the rest collapse into '+N'. */
const MODELS_SHOWN = 2;

export function TaxLadder({ taxBps, onTax }: { taxBps: number; onTax: (bps: number) => void }) {
  const noSandbox = useAppStore((s) => s.sandbox) === 'none';
  return (
    <div className="lx-tax">
      <div className="lx-tax-top">
        <div className="lx-tax-read" aria-live="polite">
          <span className="lx-tax-num">{fmtTax(taxBps)}</span>
          <span className="lx-tax-unit">CREATOR TAX</span>
        </div>
        <p className="lx-tax-why">
          Higher tax = more fuel: the AI wakes sooner and reaches stronger models sooner. Traders pay Pons&apos;s 1% plus
          this tax on every trade. It is fixed at launch, forever.
        </p>
      </div>

      <input
        className="lx-range"
        type="range"
        min={0}
        max={MAX_TAX_BPS}
        step={STEP_BPS}
        value={taxBps}
        onChange={(e) => onTax(Number(e.target.value))}
        aria-label="Creator tax"
        aria-valuetext={fmtTax(taxBps)}
        style={{ ['--fill' as string]: `${(taxBps / MAX_TAX_BPS) * 100}%` }}
      />
      <div className="lx-marks" aria-hidden="true">
        {MARKS.map((m) => (
          <button key={m} type="button" tabIndex={-1} className={m === taxBps ? 'on' : undefined} onClick={() => onTax(m)}>
            {fmtTax(m)}
          </button>
        ))}
      </div>

      <div className="tbl-wrap">
        <table className="tbl lx-ladder">
          <thead>
            <tr>
              <th>RUNG</th>
              <th className="num">FEES TO UNLOCK</th>
              <th className="num">UNLOCKS AFTER ~ TRADING VOLUME*</th>
              <th>MODELS</th>
            </tr>
          </thead>
          <tbody>
            {LAUNCH_LADDER.map((step, i) => {
              const extra = step.models.length - MODELS_SHOWN;
              return (
                <tr key={step.rung}>
                  <td>
                    <span className="lx-rung">{step.rung}</span>
                    {i === 0 && <span className="lx-rung-note">AI WAKES</span>}
                  </td>
                  <td className="num">{fmtUsd(step.unlockMicro)}</td>
                  <td className="num lx-vol">
                    {taxBps > 0 ? `~${fmtVolume(volumeForUnlock(step.unlockMicro, taxBps))}` : 'tax only: never'}
                  </td>
                  <td className="lx-models" title={step.models.join(', ')}>
                    {step.models.slice(0, MODELS_SHOWN).join(' · ')}
                    {extra > 0 && <span className="faint"> +{extra}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="form-hint lx-foot">
        * A floor, counted from the tax alone. The creator also earns a share of Pons&apos;s base fee, so real fees run
        higher and every rung arrives sooner. Unlocking a rung also unlocks that tier&apos;s tools and faster heartbeat.
        {noSandbox && (
          <> This deployment has no code sandbox, so these stay unavailable at every rung: {SANDBOX_TOOLS.join(', ')}.</>
        )}
      </p>
    </div>
  );
}

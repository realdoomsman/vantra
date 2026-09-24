// The model ladder (launchpad spec §3): rungs unlock as cumulative claimed fees grow, and the dev
// may switch the AI to any model on an unlocked rung it can currently afford. The server holds both
// gates; this view only mirrors them, and shows the server's refusal verbatim when it disagrees.
import { useState } from 'react';
import { LAUNCH_LADDER, TIER_TOOLS, fmtUsd, isSandboxTool } from '@vantra/shared';
import type { LadderView, LaunchDetail, ToolName } from '@vantra/shared';
import { useAppStore } from '../../store/app';
import { api } from '../../api/client';
import { Panel } from '../Panel';
import { actionError } from '../profile/common';
import { fmtTaxBps } from './coinFormat';

type RungState = 'locked' | 'open' | 'broke';

// A rung this router offers no model on has nothing to afford, so it reads UNLOCKED, not CAN'T AFFORD.
const stateOf = (r: LadderView): RungState =>
  !r.unlocked ? 'locked' : r.affordable || r.availableModels.length === 0 ? 'open' : 'broke';

const MARK: Record<RungState, string> = { locked: '[ ]', open: '[x]', broke: '[!]' };

/** Sandbox tools a rung adds over the rung below it — what a sandbox-less deployment cannot give it. */
function sandboxToolsAddedAt(index: number): ToolName[] {
  const own = TIER_TOOLS[LAUNCH_LADDER[index]!.tierId];
  const below = index > 0 ? TIER_TOOLS[LAUNCH_LADDER[index - 1]!.tierId] : [];
  return own.filter((t) => isSandboxTool(t) && !below.includes(t));
}

interface LadderProps {
  launch: LaunchDetail;
  isDev: boolean;
  reload: () => Promise<void>;
}

export function LaunchLadder({ launch, isDev, reload }: LadderProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canSwitch = isDev && launch.state === 'launched';
  const nextLocked = launch.ladder.find((r) => !r.unlocked) ?? null;
  const noSandbox = useAppStore((s) => s.sandbox) === 'none';

  const choose = async (model: string) => {
    setBusy(model);
    setError(null);
    try {
      await api.setLaunchModel(launch.id, model);
      await reload();
    } catch (e) {
      setError(actionError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title="MODEL LADDER"
      right={canSwitch ? 'you are the dev · pick an unlocked model' : 'unlocked by fees claimed'}
      className="coin-ladder"
      flush
    >
      {launch.ladder.map((r) => {
        const state = stateOf(r);
        const selectable = canSwitch && state === 'open';
        const toGo = Math.max(0, r.unlockMicro - launch.feesClaimedMicro);
        const rungIndex = LAUNCH_LADDER.findIndex((s) => s.rung === r.rung);
        const offHere = noSandbox && rungIndex >= 0 ? sandboxToolsAddedAt(rungIndex) : [];
        return (
          <div key={r.rung} className={`coin-rung ${state}${launch.rung === r.rung ? ' current' : ''}`}>
            <span className="coin-rung-mark">{MARK[state]}</span>
            <span className="coin-rung-name">{r.rung}</span>
            <span className="coin-rung-unlock mono-num">{fmtUsd(r.unlockMicro)}</span>
            <span className="coin-rung-state">
              {state === 'locked' && <>LOCKED · {fmtUsd(toGo)} to go</>}
              {state === 'open' && 'UNLOCKED'}
              {state === 'broke' && (
                <span title="Unlocked, but the treasury cannot keep this rung's models running for the minimum runway">
                  UNLOCKED · CAN'T AFFORD
                </span>
              )}
            </span>
            <div className="coin-rung-models">
              {r.availableModels.length === 0 ? (
                <span className="faint">no model on this router</span>
              ) : (
                r.availableModels.map((m) => {
                  const current = m === launch.model;
                  if (selectable && !current) {
                    return (
                      <button key={m} type="button" className="coin-model pick" disabled={busy !== null} onClick={() => void choose(m)}>
                        {busy === m ? 'SWITCHING…' : m}
                      </button>
                    );
                  }
                  return (
                    <span key={m} className={`coin-model${current ? ' current' : ''}`} title={current ? 'Running now' : undefined}>
                      {current && '▸ '}
                      {m}
                    </span>
                  );
                })
              )}
            </div>
            {offHere.length > 0 && (
              <div className="coin-rung-off" title="This deployment runs without a code sandbox">
                not on this deployment (no code sandbox): <b>{offHere.join(' · ')}</b>
              </div>
            )}
            {r === nextLocked && (
              <div className="coin-rung-next">
                <div className="coin-rung-track">
                  <div className="coin-rung-fill" style={{ width: `${Math.min(100, (launch.feesClaimedMicro / r.unlockMicro) * 100)}%` }} />
                </div>
                <span className="faint">
                  {launch.creatorTaxBps > 0
                    ? `≈ ${fmtUsd(Math.ceil((toGo * 10_000) / launch.creatorTaxBps), { compact: true })} more trading volume at ${fmtTaxBps(launch.creatorTaxBps)} tax`
                    : 'no creator tax · only the Pons base-fee share accrues'}
                </span>
              </div>
            )}
          </div>
        );
      })}
      {error && <div className="alert err coin-ladder-err">{error}</div>}
    </Panel>
  );
}

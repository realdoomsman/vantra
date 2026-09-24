// The coin view on a launched agent's profile (launchpad spec §8). For a launched AI this is the
// most important thing on the page, so it sits right under the profile head: the token, the fuel
// gauge (dormant → activation, or fees earned once awake), the model ladder and the burn history.
import { STRATEGY_PRESETS, fmtUsd, sameAddress } from '@vantra/shared';
import type { LaunchDetail } from '@vantra/shared';
import { CopyButton } from '../CopyButton';
import { explorerAddressUrl, fmtDate, shortKey } from '../../lib/format';
import { useAppStore } from '../../store/app';
import { ActivationBar } from './ActivationBar';
import { BurnHistory } from './BurnHistory';
import { LaunchLadder } from './LaunchLadder';
import { SimulateFees } from './SimulateFees';
import { fmtBurnPct, fmtTaxBps, fmtTokenCompact, fmtTokenUnits } from './coinFormat';

interface LaunchPanelProps {
  launch: LaunchDetail;
  /** The last refresh failed; what is on screen is the previous read. */
  stale: string | null;
  reload: () => Promise<void>;
}

const NOT_LIVE: Record<Exclude<LaunchDetail['state'], 'launched'>, { title: string; text: string }> = {
  awaiting_signature: {
    title: 'AWAITING SIGNATURE',
    text: "The dev has not signed the Pons launch yet. Until the launch is verified on chain this AI stays dormant and the coin is not listed.",
  },
  failed: {
    title: 'LAUNCH FAILED VERIFICATION',
    text: "The signed launch did not route this coin's creator fees to the AI's wallet at the requested tax. It is never listed and the AI never activates.",
  },
  expired: {
    title: 'LAUNCH EXPIRED',
    text: 'The launch was never signed within 24 hours.',
  },
};

export function LaunchPanel({ launch, stale, reload }: LaunchPanelProps) {
  const chain = useAppStore((s) => s.chainInfo);
  const me = useAppStore((s) => s.me);
  const isDev = sameAddress(me?.wallet, launch.devWallet);
  const notLive = launch.state === 'launched' ? null : NOT_LIVE[launch.state];
  const live = notLive === null;
  const dormant = launch.agentStatus === 'dormant';
  const memory = chain?.mode === 'memory';
  const explorer = launch.token && chain ? explorerAddressUrl(launch.token, chain) : null;
  const preset = launch.strategy ? STRATEGY_PRESETS.find((p) => p.id === launch.strategy) ?? null : null;

  return (
    <>
      <section className={`coin${dormant ? ' is-dormant' : ''}`}>
        <span className="coin-lbl">COIN · LAUNCHED ON PONS</span>

        <div className="coin-head">
          {launch.logoUrl && <img className="coin-logo" src={launch.logoUrl} alt="" />}
          <span className="coin-ticker">${launch.ticker}</span>
          <span className="coin-name">{launch.name}</span>
          <span className="chip">TAX {fmtTaxBps(launch.creatorTaxBps)}</span>
          {launch.token ? (
            <span className="coin-addr">
              <span className="mono-num" title={launch.token}>
                {shortKey(launch.token, 6, 4)}
              </span>
              <CopyButton text={launch.token} />
              {explorer && (
                <a href={explorer} target="_blank" rel="noreferrer">
                  EXPLORER ↗
                </a>
              )}
            </span>
          ) : (
            <span className="faint">no token address yet</span>
          )}
          {stale && <span className="coin-stale" title={stale}>STALE · {stale}</span>}
          {launch.ponsUrl && (
            <a className="btn-primary coin-pons" href={launch.ponsUrl} target="_blank" rel="noreferrer">
              TRADE ON PONS ↗
            </a>
          )}
        </div>

        <div className="coin-trust">
          <b>FEES → AI WALLET</b> Only the AI&apos;s own wallet can redirect this coin&apos;s creator fees — the
          dev cannot, and VANTRA never does.
        </div>

        {notLive ? (
          <div className="coin-notlive">
            <b>{notLive.title}</b> {notLive.text}
          </div>
        ) : (
          <div className="coin-body">
            {dormant ? (
              <div className="coin-hero">
                <span className="coin-hero-k">{launch.activatedAt ? 'DORMANT · OUT OF MONEY' : 'DORMANT · WAITING FOR FEES'}</span>
                <ActivationBar launch={launch} />
                <p className="coin-hero-line">
                  {launch.activatedAt ? 'The AI ran out of money and is asleep. ' : ''}
                  It wakes when its trading fees reach <b>{fmtUsd(launch.activationMicro)}</b>.
                </p>
              </div>
            ) : (
              <div className="coin-hero coin-big">
                <div className="coin-cell accent">
                  <span className="coin-hero-k">FEES EARNED</span>
                  <span className="coin-v">{fmtUsd(launch.feesClaimedMicro)}</span>
                  <span className="coin-sub">+{fmtUsd(launch.feesPendingMicro, { decimals: 2 })} pending in escrow</span>
                </div>
                <div className="coin-cell">
                  <span className="coin-hero-k">RUNG</span>
                  <span className="coin-v">{launch.rung ?? '—'}</span>
                  <span className="coin-sub">{launch.model}</span>
                </div>
                <div className="coin-cell">
                  <span className="coin-hero-k">SUPPLY BURNED</span>
                  <span className="coin-v">{fmtBurnPct(launch.burnedPct)}</span>
                  <span className="coin-sub" title={`${fmtTokenUnits(launch.burnedTokens)} tokens`}>
                    {fmtTokenCompact(launch.burnedTokens)} ${launch.ticker}
                  </span>
                </div>
                <div className="coin-cell">
                  <span className="coin-hero-k">BUYBACKS</span>
                  <span className="coin-v">{fmtUsd(launch.burnedMicro)}</span>
                  <span className="coin-sub">
                    {launch.burns.length} burn{launch.burns.length === 1 ? '' : 's'}
                  </span>
                </div>
              </div>
            )}

            <div className="coin-lines">
              {dormant && (
                <span>
                  FEES CLAIMED <b>{fmtUsd(launch.feesClaimedMicro)}</b>
                </span>
              )}
              {dormant && (
                <span>
                  RUNG <b>{launch.rung ?? 'none yet'}</b>
                </span>
              )}
              <span>
                TREASURY <b>{fmtUsd(launch.treasuryMicro)}</b>
              </span>
              <span>
                RUNWAY <b>{dormant ? '—' : launch.runwayDays === null ? '∞' : `${launch.runwayDays.toFixed(1)}d`}</b>
              </span>
              {!dormant && launch.activatedAt && (
                <span>
                  ACTIVATED <b>{fmtDate(launch.activatedAt)}</b>
                </span>
              )}
              {launch.launchedAt && (
                <span>
                  LAUNCHED <b>{fmtDate(launch.launchedAt)}</b>
                </span>
              )}
              <span>
                DEV <b title={launch.devWallet}>{isDev ? 'YOU' : shortKey(launch.devWallet, 4, 4)}</b>
              </span>
              {preset && (
                <span>
                  STRATEGY <b title={preset.blurb}>{preset.label}</b>
                </span>
              )}
            </div>

            {launch.instructions && (
              <div className="coin-brief">
                <span className="coin-hero-k">DEV&apos;S BRIEF</span> {launch.instructions}
              </div>
            )}
          </div>
        )}

        {live && memory && <SimulateFees launch={launch} reload={reload} />}
      </section>

      {live && (
        <div className="grid cols-2 section-gap coin-grid">
          <LaunchLadder launch={launch} isDev={isDev} reload={reload} />
          <BurnHistory launch={launch} chain={chain} />
        </div>
      )}
    </>
  );
}

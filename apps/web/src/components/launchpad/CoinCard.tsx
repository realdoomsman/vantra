// One launched coin in the directory. Every card has the same anatomy so a wall of them scans like a
// table: identity + AI status, one line of pitch, four figures, and a footer that is either the
// activation bar (dormant) or the rung and model the AI runs on. Exactly one element per card
// carries the accent: the activation bar while the AI sleeps, the share of supply burned once it
// is awake — the two numbers the whole idea hangs on.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { LaunchPublic } from '@vantra/shared';
import { fmtUsd } from '@vantra/shared';
import { fmtAgo } from '../../lib/format';
import {
  activationProgress, aiStatus, feesEarnedMicro, fmtBurnedPct, fmtRunway, fmtTax, fmtUsdCompact,
} from './launchFormat';

export function CoinCard({ launch }: { launch: LaunchPublic }) {
  const status = aiStatus(launch.agentStatus);
  const dormant = launch.agentStatus === 'dormant';
  const fees = feesEarnedMicro(launch);
  const progress = activationProgress(launch);

  return (
    <Link
      to={`/a/${launch.agentId}`}
      className={`lpd-card${dormant ? ' is-dormant' : ''}${launch.agentStatus === 'dead' ? ' is-dead' : ''}`}
    >
      <div className="lpd-card-head">
        <CoinMark logoUrl={launch.logoUrl} ticker={launch.ticker} />
        <div className="lpd-card-id">
          <span className="lpd-ticker">${launch.ticker}</span>
          <span className="lpd-name" title={launch.name}>
            {launch.name}
          </span>
        </div>
        <span className={`lpd-status tone-${status.tone}`}>
          <i aria-hidden="true" />
          {status.label}
        </span>
      </div>

      <p className="lpd-desc" title={launch.description}>
        {launch.description || launch.instructions || '—'}
      </p>

      <dl className="lpd-figs">
        <div>
          <dt>TAX</dt>
          <dd>{fmtTax(launch.creatorTaxBps)}</dd>
        </div>
        <div title={`${fmtUsd(launch.feesClaimedMicro)} claimed · ${fmtUsd(launch.feesPendingMicro)} in escrow`}>
          <dt>FEES</dt>
          <dd>{fmtUsdCompact(fees)}</dd>
        </div>
        <div title={`${fmtUsd(launch.burnedMicro)} spent on buyback-and-burn`}>
          <dt>BURNED</dt>
          <dd className={dormant ? undefined : 'is-accent'}>{fmtBurnedPct(launch.burnedPct)}</dd>
        </div>
        <div>
          <dt>RUNWAY</dt>
          <dd>{dormant ? '—' : fmtRunway(launch.runwayDays)}</dd>
        </div>
      </dl>

      {dormant ? (
        <div className="lpd-act" title={`${Math.round(progress * 100)}% of the way to waking`}>
          <div className="lpd-act-k">
            <span>{launch.activatedAt ? 'REACTIVATES AT' : 'WAKES AT'} {fmtUsd(launch.activationMicro)}</span>
            <b>{fmtUsd(launch.feesPendingMicro)}</b>
          </div>
          <div className="lpd-act-bar">
            <i style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      ) : (
        <div className="lpd-foot">
          <span className="lpd-rung">{launch.rung ?? 'NO RUNG'}</span>
          <span className="lpd-model" title={launch.model}>
            {launch.model}
          </span>
          <span className="lpd-age">{fmtAgo(launch.launchedAt ?? launch.createdAt)}</span>
        </div>
      )}
    </Link>
  );
}

/** The coin's logo, or its ticker's first letter when there is none or it fails to load. */
function CoinMark({ logoUrl, ticker }: { logoUrl: string | null; ticker: string }) {
  const [broken, setBroken] = useState(false);
  if (logoUrl && !broken) {
    return <img className="lpd-mark" src={logoUrl} alt="" loading="lazy" onError={() => setBroken(true)} />;
  }
  return (
    <span className="lpd-mark is-letter" aria-hidden="true">
      {ticker.slice(0, 1)}
    </span>
  );
}

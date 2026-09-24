// Public profile head + runway hero (SPEC-V2 §9.7). The owner panel has moved to the control
// board, so the only owner-shaped thing left here is the button that opens it.
//
// A launched agent's coin is shown by the launch panel under this head, so the page passes the
// launch down: `undefined` while it is being read, `null` for a bought agent. The token banner is
// for bought agents only, and a dormant AI's hero reads its activation progress, never `∞`.
import { Link } from 'react-router-dom';
import type { LaunchDetail } from '@vantra/shared';
import { MAX_TOOL_ROUNDS_PER_STEP, fmtUsd } from '@vantra/shared';
import { AgentBadges } from '../Badge';
import { CopyButton } from '../CopyButton';
import { Countdown } from '../Countdown';
import { RunwayStrip } from '../RunwayStrip';
import { SurvivalScore } from './SurvivalScore';
import { TokenBadge } from './TokenBadge';
import type { ProfileProps } from './common';
import { explorerAddressUrl, fmtAgeDays, fmtDate, shortKey } from '../../lib/format';
import { useAppStore } from '../../store/app';

interface ProfileHeadProps extends ProfileProps {
  launch: LaunchDetail | null | undefined;
}

export function ProfileHead({ agent, launch }: ProfileHeadProps) {
  const chain = useAppStore((s) => s.chainInfo);
  const explorer = chain ? explorerAddressUrl(agent.walletPubkey, chain) : null;
  const site = agent.deployments.find((d) => d.active) ?? null;
  const forkable = agent.shareStrategy && agent.hasStrategy;
  const spawning = agent.status === 'spawning';
  const dormant = agent.status === 'dormant';

  return (
    <>
      <div className="profile-head">
        <div className="profile-name-block">
          <div className="profile-name">{agent.name}</div>
          <div className="profile-meta">
            <span className="m">
              ID <b>{agent.id}</b>
            </span>
            <span className="m">
              {launch ? 'DEV' : 'OWNER'}{' '}
              {agent.ownerWallet ? (
                <b>{shortKey(agent.ownerWallet, 4, 4)}</b>
              ) : (
                <b title="Bought with a deposit address; the owner holds a claim code, not a wallet">CLAIM CODE</b>
              )}
            </span>
            {launch ? (
              <span className="m">
                FUNDED BY <b>${launch.ticker}</b> trading fees · no seed
              </span>
            ) : (
              agent.tierId && (
                <span className="m">
                  TIER <b>{agent.tierId}</b> · bought for <b>{fmtUsd(agent.fundingMicro)}</b> of treasury
                </span>
              )
            )}
            <span className="m">
              BORN <b>{fmtDate(agent.bornAt)}</b> · <b>{agent.ageDays.toFixed(1)}d</b>
            </span>
            {agent.diedAt && (
              <span className="m">
                DIED <b className="neg">{fmtDate(agent.diedAt)}</b>
              </span>
            )}
            <span className="m">
              MODEL <b>{agent.model}</b> · {agent.effort}
            </span>
            <span className="m">
              GEN <b>{agent.generation}</b>
              {agent.parent && (
                <>
                  {' ← '}
                  <Link to={`/a/${agent.parent.id}`}>{agent.parent.name}</Link>
                </>
              )}
              {agent.forkCount > 0 && ` · ${agent.forkCount} fork${agent.forkCount === 1 ? '' : 's'}`}
            </span>
            <span className="m">
              WALLET <b>{shortKey(agent.walletPubkey, 4, 4)}</b>
              <CopyButton text={agent.walletPubkey} />
              {explorer && (
                <a href={explorer} target="_blank" rel="noreferrer">
                  EXPLORER ↗
                </a>
              )}
            </span>
            {site && (
              <span className="m">
                SITE{' '}
                <a href={site.url} target="_blank" rel="noreferrer">
                  {site.slug} ↗
                </a>
              </span>
            )}
          </div>
        </div>
        <div className="profile-head-right">
          <div className="sv-head">
            <span className="sv-head-label">SURVIVAL</span>
            <SurvivalScore score={agent.survivalScore} grade={agent.survivalGrade} size="md" />
          </div>
          <AgentBadges agent={agent} label={spawning ? 'SPAWNING…' : undefined} />
          {agent.revivals > 0 && <span className="chip">REVIVED ×{agent.revivals}</span>}
          {forkable && <span className="chip">STRATEGY PUBLIC</span>}
          {agent.isOwner ? (
            <Link className="btn-primary" to={`/control/${agent.id}`}>OPEN CONTROL BOARD →</Link>
          ) : (
            forkable && (
              <Link className="btn-ghost" to={`/buy?fork=${agent.id}`}>
                FORK THIS STRATEGY
              </Link>
            )
          )}
        </div>
      </div>

      {launch === null && <TokenBadge token={agent.token} />}

      {spawning && agent.spawnError && (
        <div className="alert err">
          <span>FUNDING FAILED · {agent.spawnError} — the money is safe and the protocol retries automatically.</span>
        </div>
      )}

      <div className="runway-hero">
        <div className="runway-hero-top">
          <span className="lbl">{dormant ? 'DORMANT · FEES TO WAKE' : 'LIFE REMAINING'}</span>
          {dormant ? (
            <span className="val dormant">
              {launch ? `${fmtUsd(launch.feesPendingMicro)} / ${fmtUsd(launch.activationMicro)}` : 'DORMANT'}
            </span>
          ) : (
            <span className={heroValClass(agent.runwayDays, agent.status === 'dead')}>{heroVal(agent.runwayDays, agent.status === 'dead', agent.ageDays)}</span>
          )}
        </div>
        <div className="hero-strip">
          <RunwayStrip runwayDays={agent.runwayDays} status={agent.status} ageDays={agent.ageDays} size="lg" />
        </div>
        <div className="hero-line">
          <span>
            TREASURY <b>{fmtUsd(agent.treasuryMicro)}</b>
          </span>
          <span>
            BURN/DAY <b>{fmtUsd(agent.burnPerDayMicro)}</b> <span className="faint">({agent.burnBasis})</span>
          </span>
          <span>
            STEPS <b>{agent.totalSteps}</b>
          </span>
          {agent.status !== 'dead' && agent.nextStepAt && (
            <span>
              NEXT STEP IN <b><Countdown to={agent.nextStepAt} /></b>
            </span>
          )}
          <span>
            HEARTBEAT <b>{agent.heartbeatMin}m</b>
          </span>
        </div>
        {dormant && (
          <div className="hero-dormant">
            Charged no rent while dormant. It wakes on its own when its coin&apos;s trading fees reach{' '}
            <b>{launch ? fmtUsd(launch.activationMicro) : 'the activation threshold'}</b>.
          </div>
        )}
        {agent.stepping && (
          <div className="hero-think">
            <span className="pulse-dot" />
            THINKING · round {agent.currentRound ?? 1}/{MAX_TOOL_ROUNDS_PER_STEP} · {agent.model}
          </div>
        )}
        {spawning && !agent.spawnError && (
          <div className="hero-think">
            <span className="pulse-dot" />
            Moving {fmtUsd(agent.fundingMicro)} USDC + gas from the treasury into its own wallet
          </div>
        )}
        {agent.summary && <div className="hero-summary">{agent.summary}</div>}
      </div>
    </>
  );
}

const heroValClass = (runwayDays: number | null, dead: boolean): string => {
  if (dead) return 'val neg';
  if (runwayDays === null) return 'val';
  if (runwayDays < 3) return 'val neg';
  return runwayDays < 14 ? 'val warn' : 'val';
};

const heroVal = (runwayDays: number | null, dead: boolean, ageDays: number): string => {
  if (dead) return `DIED ${fmtAgeDays(ageDays)}`;
  if (runwayDays === null) return '∞';
  return `${runwayDays.toFixed(1)}d`;
};

// Profile stat tiles (AMENDMENTS D33).
import { fmtUsd } from '@vantra/shared';
import { StatTile } from '../StatTile';
import type { ProfileProps } from './common';
import { fmtAgo } from '../../lib/format';

export function ProfileTiles({ agent }: ProfileProps) {
  const profitTone = agent.profitMicro > 0 ? 'pos' : agent.profitMicro < 0 ? 'neg' : undefined;
  const withdrawable = agent.withdrawable;

  return (
    <div className="grid cols-4">
      <StatTile
        label="TREASURY"
        value={fmtUsd(agent.treasuryMicro)}
        delta={`on-chain ${fmtUsd(agent.onchainUsdcMicro)} · unsettled ${fmtUsd(agent.unsettledMicro)}`}
      />
      {/* Only money tied to an outside customer counts here. Unattributed inflows are spendable but
          are shown separately so the headline number cannot be inflated with a second keypair. */}
      <StatTile
        label="EXTERNAL REVENUE"
        value={fmtUsd(agent.revenueExternalMicro)}
        delta={
          agent.revenuePendingMicro > 0
            ? `${fmtUsd(agent.revenuePendingMicro)} unattributed · not counted`
            : agent.paidBack ? 'PAID ITSELF BACK' : `${fmtUsd(agent.fundingMicro)} of funding not earned back`
        }
        deltaTone={agent.revenuePendingMicro > 0 ? 'warn' : agent.paidBack ? 'pos' : undefined}
      />
      <StatTile
        label="INTERNAL REVENUE"
        value={fmtUsd(agent.revenueInternalMicro)}
        delta={`royalties in ${fmtUsd(agent.royaltyInMicro)}`}
      />
      <StatTile
        label="OWNER TOP-UPS"
        value={fmtUsd(agent.recapitalizedMicro)}
        delta={agent.revivals > 0 ? `${agent.revivals} revival${agent.revivals === 1 ? '' : 's'}` : 'never recapitalized'}
      />
      <StatTile
        label="WITHDRAWN"
        value={fmtUsd(agent.withdrawnMicro)}
        delta={withdrawable.eligible ? `${fmtUsd(withdrawable.amountMicro)} withdrawable` : (withdrawable.reason ?? 'not withdrawable yet')}
        deltaTone={withdrawable.eligible ? 'pos' : undefined}
      />
      <StatTile
        label="P&L"
        value={<span className={profitTone}>{fmtUsd(agent.profitMicro, { sign: true })}</span>}
        delta={`burn ${fmtUsd(agent.burnPerDayMicro)}/day · ${agent.burnBasis}`}
        deltaTone={profitTone}
      />
      <StatTile
        label="STEPS"
        value={agent.totalSteps.toLocaleString('en-US')}
        delta={agent.lastStepAt ? `last ${fmtAgo(agent.lastStepAt)}` : 'no step yet'}
      />
    </div>
  );
}

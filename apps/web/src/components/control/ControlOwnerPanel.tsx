// OWNER ACTIONS (SPEC-V2 §9.7): the v1 cards, unchanged, plus the two top-up doors.
import { PROTOCOL_DISCLAIMER } from '@vantra/shared';
import { Panel } from '../Panel';
import { RecapitalizeCard, ReviveCard, WithdrawCard } from '../profile/OwnerFunding';
import { HeartbeatCard, MessageCard, PauseCard, ShareCard, TerminateCard } from '../profile/ownerCards';
import { TopUpCard } from './TopUpCard';
import type { OwnerProps } from '../profile/common';

export function ControlOwnerPanel({ agent, refresh }: OwnerProps) {
  const dead = agent.status === 'dead';

  return (
    <Panel className="section-gap" title="OWNER ACTIONS" right={agent.ownerKind === 'claim' ? 'CLAIM IDENTITY' : 'WALLET OWNER'}>
      <div className="owner-grid">
        <TopUpCard agent={agent} refresh={refresh} />
        {!dead && <RecapitalizeCard agent={agent} refresh={refresh} />}
        {!dead && <MessageCard agent={agent} refresh={refresh} />}
        {!dead && <PauseCard agent={agent} refresh={refresh} />}
        {!dead && <HeartbeatCard agent={agent} refresh={refresh} />}
        <ShareCard agent={agent} refresh={refresh} />
        {(!dead || agent.withdrawable.eligible) && <WithdrawCard agent={agent} refresh={refresh} />}
        {dead && <ReviveCard agent={agent} refresh={refresh} />}
        {!dead && <TerminateCard agent={agent} refresh={refresh} />}
      </div>
      <div className="note">{PROTOCOL_DISCLAIMER}</div>
    </Panel>
  );
}

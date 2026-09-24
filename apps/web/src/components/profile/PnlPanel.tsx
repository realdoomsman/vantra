// Where the money went: one bar per cost centre (AMENDMENTS D33).
// One series → one colour; the P&L headline sits in the panel header.
import { fmtUsd } from '@vantra/shared';
import { Panel } from '../Panel';
import { BarRows } from '../charts/BarRows';
import type { BarRow } from '../charts/BarRows';
import type { ProfileProps } from './common';

export function PnlPanel({ agent }: ProfileProps) {
  const costs: [string, number][] = [
    ['INFERENCE', agent.spendInferenceMicro],
    ['RENT', agent.spendRentMicro],
    ['COMPUTE', agent.spendComputeMicro],
    ['TOOLS', agent.spendToolsMicro],
    ['HOSTING', agent.spendHostingMicro],
    ['GAS', agent.spendGasMicro],
    ['PAYMENTS', agent.spendPaymentsMicro],
    ['ROYALTIES OUT', agent.royaltyOutMicro],
  ];
  const rows: BarRow[] = costs
    .filter(([, value]) => value > 0)
    .map(([label, value]) => ({
      key: label,
      label,
      segments: [{ value, color: 'warn' }],
      valueText: fmtUsd(value),
    }));
  const spent = costs.reduce((a, [, v]) => a + v, 0);
  const tone = agent.profitMicro > 0 ? 'pos' : agent.profitMicro < 0 ? 'neg' : undefined;

  return (
    <Panel
      title="P&L"
      right={
        <>
          SPENT {fmtUsd(spent)} · P&L <b className={tone}>{fmtUsd(agent.profitMicro, { sign: true })}</b>
        </>
      }
    >
      <BarRows rows={rows} formatValue={(v) => fmtUsd(v)} emptyTitle="NOTHING SPENT YET" />
    </Panel>
  );
}

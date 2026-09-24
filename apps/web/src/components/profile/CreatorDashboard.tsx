// CREATOR DASHBOARD (owner-only): launch the agent's one official token, then watch where its money
// goes. Three blocks — the token (launch or manage), the treasury split its creator rewards fund,
// and the operating cost centres. Gated by the caller on AgentDetail.isOwner.
import { useState } from 'react';
import { fmtUsd } from '@vantra/shared';
import { api } from '../../api/client';
import { CopyButton } from '../CopyButton';
import { Panel } from '../Panel';
import { useAppStore } from '../../store/app';
import { useAction } from './common';
import type { OwnerProps, ProfileProps } from './common';
import { shortKey } from '../../lib/format';

function TokenCard({ agent, refresh }: OwnerProps) {
  const { busy, error, run } = useAction(refresh);
  const [ticker, setTicker] = useState('');
  const tokenLaunch = useAppStore((s) => s.tokenLaunch);
  const token = agent.token;
  if (token) {
    const taxPct = (token.creatorTaxBps / 100).toFixed(token.creatorTaxBps % 100 === 0 ? 0 : 2);
    return (
      <div className="owner-card">
        <div className="oc-title">OFFICIAL AGENT TOKEN</div>
        <div className="token-official">
          <span className="tb-ticker">${token.ticker}</span>
          <span className="dim">{token.name}</span>
        </div>
        <div className="form-row section-gap">
          <span className="mono-num" title={token.token}>{shortKey(token.token, 6, 6)}</span>
          <CopyButton text={token.token} />
        </div>
        <div className="form-row section-gap">
          <a className="btn-primary" href={token.ponsUrl} target="_blank" rel="noreferrer">
            TRADE ON PONS ↗
          </a>
        </div>
        <div className="fee-wallet section-gap">
          <span className="k">CREATOR FEE WALLET</span>
          <span className="mono-num" title={agent.walletPubkey}>{shortKey(agent.walletPubkey, 6, 6)}</span>
          <CopyButton text={agent.walletPubkey} />
        </div>
        <div className="note">
          A {taxPct}% creator tax on every ${token.ticker} trade accrues to this agent's own wallet in the Pons fee
          escrow, and is claimed into its treasury every few hours (converted to USDC). The rate was fixed at launch.
          One agent, one token — permanent.
        </div>
      </div>
    );
  }

  const launch = () => run(() => api.launchToken(agent.id, ticker.trim() || undefined));

  if (!tokenLaunch) {
    return (
      <div className="owner-card">
        <div className="oc-title">LAUNCH TOKEN</div>
        <div className="form-row">
          <button type="button" className="btn-primary" disabled>
            TOKEN LAUNCHES COMING SOON
          </button>
        </div>
        <div className="note">
          Agent token launches are not enabled yet. When they open, this agent can launch its one official token on
          Pons and its creator tax will fund the treasury.
        </div>
      </div>
    );
  }

  return (
    <div className="owner-card">
      <div className="oc-title">LAUNCH TOKEN</div>
      <div className="form-row">
        <input
          className="finput"
          value={ticker}
          maxLength={10}
          placeholder="TICKER · optional"
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          aria-label="Token ticker"
        />
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void launch()}>
          {busy ? 'LAUNCHING…' : 'LAUNCH TOKEN'}
        </button>
      </div>
      {error && <div className="alert err">{error}</div>}
      <div className="note">
        Launch this agent's one official token on Pons. The public agent page becomes its token page, and the creator
        tax on every trade is routed to the agent's own wallet and swept into its treasury.
      </div>
    </div>
  );
}

function TreasurySplitCard({ agent }: ProfileProps) {
  const s = agent.treasurySplit;
  const rows: [string, number][] = [
    ['PROTECTED RESERVE', s.reserveMicro],
    ['DEPLOYABLE', s.deployableMicro],
    ['OPEN POSITIONS', s.openPositionsMicro],
  ];

  return (
    <div className="owner-card">
      <div className="oc-title">TREASURY SPLIT</div>
      <div className="commission-ledger">
        {rows.map(([label, value]) => (
          <div className="cl-row" key={label}>
            <span className="k">{label}</span>
            <span className="v">{fmtUsd(value)}</span>
          </div>
        ))}
      </div>
      <div className="note">Reserve is the liquid floor the agent never trades below; deployable is capital it can put to work; open positions are marked to market.</div>
    </div>
  );
}

function OperationsCard({ agent }: ProfileProps) {
  const rows: [string, number][] = [
    ['INFERENCE', agent.spendInferenceMicro],
    ['COMPUTE', agent.spendComputeMicro],
    ['TOOLS', agent.spendToolsMicro],
    ['HOSTING', agent.spendHostingMicro],
    ['RENT', agent.spendRentMicro],
    ['GAS', agent.spendGasMicro],
  ];
  const total = rows.reduce((sum, [, v]) => sum + v, 0);

  return (
    <div className="owner-card">
      <div className="oc-title">OPERATIONS</div>
      <div className="commission-ledger">
        {rows.map(([label, value]) => (
          <div className="cl-row" key={label}>
            <span className="k">{label}</span>
            <span className="v">{fmtUsd(value)}</span>
          </div>
        ))}
        <div className="cl-row total">
          <span className="k">TOTAL SPENT</span>
          <span className="v neg">{fmtUsd(total)}</span>
        </div>
      </div>
      <div className="note">Lifetime spend by cost centre — what it has cost to keep this agent thinking and alive.</div>
    </div>
  );
}

export function CreatorDashboard({ agent, refresh }: OwnerProps) {
  return (
    <Panel className="section-gap" title="CREATOR DASHBOARD" right="OWNER ONLY">
      <div className="owner-grid">
        <TokenCard agent={agent} refresh={refresh} />
        <TreasurySplitCard agent={agent} />
        <OperationsCard agent={agent} />
      </div>
    </Panel>
  );
}

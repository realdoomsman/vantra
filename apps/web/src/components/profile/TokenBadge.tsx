// The public token banner near the profile header (SPEC: one agent = one token). When a token is
// launched the agent page becomes its token page, so the banner carries the ticker, the contract
// address (copyable) and a Trade call-to-action; before launch it stays a subtle placeholder.
import type { AgentTokenInfo } from '@vantra/shared';
import { CopyButton } from '../CopyButton';
import { shortKey } from '../../lib/format';

export function TokenBadge({ token }: { token: AgentTokenInfo | null }) {
  if (!token) {
    return (
      <div className="token-banner">
        <span className="tb-label">TOKEN</span>
        <span className="tb-none">NOT LAUNCHED</span>
      </div>
    );
  }
  return (
    <div className="token-banner launched">
      <span className="tb-label">OFFICIAL AGENT TOKEN</span>
      <span className="tb-ticker">${token.ticker}</span>
      <span className="tb-mint mono-num" title={token.token}>
        {shortKey(token.token, 6, 4)}
      </span>
      <CopyButton text={token.token} />
      <a className="btn-primary tb-buy" href={token.ponsUrl} target="_blank" rel="noreferrer">
        TRADE ON PONS ↗
      </a>
    </div>
  );
}

// The control board is private. A viewer who is not the owner gets the two ways back in, side by
// side, and a link to the public profile (SPEC-V2 §9.7).
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { isClaimCode, normalizeClaimCode } from '@vantra/shared';
import { api, isApiError } from '../../api/client';
import { WalletButton } from '../WalletButton';
import { useAppStore } from '../../store/app';
import { useWalletStore } from '../../store/wallet';

export function ClaimGate({ agentId, agentName }: { agentId: string; agentName: string | null }) {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = isClaimCode(code);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const me = await api.claim(normalizeClaimCode(code));
      useAppStore.getState().setMe(me);
      useWalletStore.setState({ status: 'signed', error: null });
      // Landing back on the same URL re-runs the access check, now with a session.
      navigate(`/control/${agentId}`, { replace: true });
    } catch (e) {
      setError(isApiError(e) ? e.message : 'That claim code is not valid.');
      setBusy(false);
    }
  };

  return (
    <div className="control-gate">
      <div className="cg-box">
        <div className="cg-title">PRIVATE CONTROL BOARD</div>
        <p className="cg-lede">
          This is a private control board. Paste the claim code you were shown when you bought this agent, or connect
          the wallet that paid for it.
        </p>

        <div className="cg-ways">
          <div className="cg-way">
            <div className="cg-way-t">CLAIM CODE</div>
            <input
              className="finput claim-input"
              value={code}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="characters"
              placeholder="RW-XXXXX-XXXXX-XXXXX-XXXXX"
              aria-label="Claim code"
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            />
            <button type="button" className="btn-primary" disabled={!valid || busy} onClick={() => void submit()}>
              {busy ? 'CHECKING…' : 'UNLOCK'}
            </button>
          </div>
          <div className="cg-way">
            <div className="cg-way-t">OWNER WALLET</div>
            <WalletButton />
            <div className="note">Sign in with the wallet that paid for {agentName ?? 'this agent'}.</div>
          </div>
        </div>

        {error && <div className="alert err">{error}</div>}

        <div className="cg-foot">
          <Link to={`/a/${agentId}`}>PUBLIC PROFILE →</Link>
          <Link to="/">HOME</Link>
        </div>
      </div>
    </div>
  );
}

// SPEC-V2 §9.6 — the claim code is the whole credential for the no-wallet path.
// One input, auto-uppercased and auto-dashed, validated locally before it is ever posted.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatClaimCode, isClaimCode, normalizeClaimCode } from '@vantra/shared';
import { api, isApiError } from '../api/client';
import { Panel } from '../components/Panel';
import { useAppStore } from '../store/app';
import { useWalletStore } from '../store/wallet';
import '../styles/pages2.css';

/**
 * As the buyer types: normalize, then re-print in RW-XXXXX-… groups so it reads back correctly.
 * Below three characters the raw text is echoed instead, otherwise re-adding the 'RW' prefix on
 * every keystroke would make the field impossible to clear with backspace.
 */
function pretty(raw: string): string {
  const kept = raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (kept.length <= 2) return kept;
  return formatClaimCode(normalizeClaimCode(kept).slice(0, 22));
}

export default function Claim() {
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
      if (me.agents.length === 1) navigate(`/control/${me.agents[0]!.id}`, { replace: true });
      else navigate('/mine', { replace: true });
    } catch (e) {
      setError(isApiError(e) ? e.message : 'That claim code is not valid.');
      setBusy(false);
    }
  };

  return (
    <div className="spawn-wrap">
      <div className="page-head">
        <h1 className="page-title">CLAIM YOUR AGENT</h1>
        <p className="page-sub">
          Paste the claim code you were shown when you bought the agent. It signs you in on this browser and opens the
          control board. No wallet, no extension, no email.
        </p>
      </div>

      <Panel title="CLAIM CODE">
        <div className="form-row">
          <input
            className="finput claim-input"
            value={code}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="characters"
            placeholder="RW-XXXXX-XXXXX-XXXXX-XXXXX"
            aria-label="Claim code"
            onChange={(e) => setCode(pretty(e.target.value))}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          />
          <button type="button" className="btn-primary" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? 'CHECKING…' : 'CLAIM'}
          </button>
        </div>
        {error ? (
          <div className="alert err section-gap">
            <span>
              {error} If you bought the agent from a connected wallet instead, there is no claim code — sign in with
              that wallet using CONNECT WALLET in the top bar.
            </span>
          </div>
        ) : (
          <div className="form-hint">
            Dashes, spaces and lower case are all fine; the code is normalized before it is sent.
          </div>
        )}
      </Panel>

      <div className="note">
        The code is stored only as a hash, peppered with a server secret, so a database dump alone cannot be turned back
        into it — and neither can we. If you have lost it, the agent keeps running and stays public at{' '}
        <Link to="/agents">/agents</Link>, but nobody can control it. <Link to="/buy">Buy another →</Link>
      </div>
    </div>
  );
}

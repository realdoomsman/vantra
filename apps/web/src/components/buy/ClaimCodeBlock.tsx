// The claim code, shown exactly once (SPEC-V2 §9.5). It arrives in the create response and lives
// in component state only — never localStorage, never a URL — so a reload really does lose it.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatClaimCode, normalizeClaimCode } from '@vantra/shared';
import { CopyButton } from '../CopyButton';

export function ClaimCodeBlock({ code }: { code: string }) {
  const [saved, setSaved] = useState(false);
  const pretty = formatClaimCode(normalizeClaimCode(code));

  if (saved) {
    return (
      <div className="alert">
        <span>
          Claim code saved. It is no longer on screen. Use it at <Link to="/claim">/claim</Link> from any browser to get
          back into this agent.
        </span>
      </div>
    );
  }

  return (
    <div className="claim-code">
      <div className="cc-warn">SAVE THIS NOW. IT IS THE ONLY WAY BACK INTO YOUR AGENT. WE CANNOT RECOVER IT.</div>
      <div className="cc-code">{pretty}</div>
      <div className="cc-actions">
        <CopyButton text={pretty} label="COPY CLAIM CODE" />
        <label className="cc-check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          I have saved my claim code
        </label>
      </div>
      <div className="note">
        This code is your whole identity here: it signs you in, it opens the control board, and it is the only thing
        that proves the agent is yours. It is stored only as a hash on the server, so nobody — including us — can read
        it back to you. Write it down somewhere you will still have in a month.
      </div>
    </div>
  );
}

/** Shown in place of the code after a reload: the code is genuinely gone. */
export function ClaimCodeLost() {
  return (
    <div className="alert warn">
      <span>
        The claim code was shown once, when this purchase was created, and this page has been reloaded since. If you
        saved it, sign in at <Link to="/claim">/claim</Link>. If you did not, the purchase still completes and the agent
        still spawns — but you will not be able to control it.
      </span>
    </div>
  );
}

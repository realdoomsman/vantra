import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { sameAddress } from '@vantra/shared';
import { useWallet } from '../providers/WalletProvider';
import { shortKey } from '../lib/format';
import { useAppStore } from '../store/app';
import { useWalletStore } from '../store/wallet';

/**
 * Custom wallet control.
 * A claim-code session wins over everything: it is a real owner identity with no wallet at all.
 * memory/demo mode → "DEMO WALLET" signs in through POST /api/auth/demo.
 * otherwise: pick an announced wallet → connect → switch to Robinhood Chain if the wallet is on
 * another network → SIGN IN (nonce/personal_sign/verify) → session.
 */
export function WalletButton() {
  const demo = useAppStore((s) => (s.stats ? s.stats.demo : null));
  const me = useAppStore((s) => s.me);
  if (me && (me.ownerKind === 'claim' || me.ownerKind === 'google')) return <ClaimSessionButton />;
  if (demo === null) return <button type="button" className="wallet-btn" disabled>…</button>;
  return demo ? <DemoWalletButton /> : <InjectedWalletButton />;
}

function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return { open, setOpen, ref };
}

function MyAgentsLink({ onGo }: { onGo: () => void }) {
  return (
    <Link className="wm-link" to="/mine" onClick={onGo}>
      MY AGENTS
    </Link>
  );
}

/** The no-wallet identity: the claim code already minted the same session cookie. */
function ClaimSessionButton() {
  const me = useAppStore((s) => s.me);
  const { signOut } = useWalletStore();
  const { open, setOpen, ref } = useMenu();
  if (!me) return null;

  return (
    <div className="wallet-wrap" ref={ref}>
      <button type="button" className="wallet-btn connected" onClick={() => setOpen((o) => !o)}>
        CLAIM <b>{me.agents.length} AGENT{me.agents.length === 1 ? '' : 'S'}</b>
      </button>
      {open && (
        <div className="wallet-menu">
          <div className="wm-note">CLAIM-CODE IDENTITY · NO WALLET</div>
          <MyAgentsLink onGo={() => setOpen(false)} />
          <button type="button" onClick={() => { setOpen(false); void signOut(); }}>SIGN OUT</button>
        </div>
      )}
    </div>
  );
}

function DemoWalletButton() {
  const me = useAppStore((s) => s.me);
  const { status, error, signInDemo, signOut, clearError } = useWalletStore();
  const { open, setOpen, ref } = useMenu();

  if (me) {
    return (
      <div className="wallet-wrap" ref={ref}>
        <button type="button" className="wallet-btn connected" onClick={() => setOpen((o) => !o)}>
          DEMO <b>{shortKey(me.wallet ?? me.ownerId, 9, 4)}</b>
        </button>
        {open && (
          <div className="wallet-menu">
            <div className="wm-note">SIMULATED SESSION · NO KEYS</div>
            <MyAgentsLink onGo={() => setOpen(false)} />
            <button type="button" onClick={() => { setOpen(false); void signOut(); }}>SIGN OUT</button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="wallet-wrap" ref={ref}>
      <button type="button" className="wallet-btn" disabled={status === 'signing'} onClick={() => { clearError(); void signInDemo(); }}>
        {status === 'signing' ? 'SIGNING…' : 'DEMO WALLET'}
      </button>
      {error && (
        <div className="wallet-menu">
          <div className="wm-note wm-err">{error}</div>
        </div>
      )}
    </div>
  );
}

function InjectedWalletButton() {
  const me = useAppStore((s) => s.me);
  const googleAuth = useAppStore((s) => s.googleAuth);
  const {
    wallets, wallet, select, connect, disconnect, connected, connecting, publicKey, signMessage,
    wrongNetwork, switchNetwork, chain,
  } = useWallet();
  const { status, error, signIn, signOut, clearError } = useWalletStore();
  const { open, setOpen, ref } = useMenu();
  const [pendingConnect, setPendingConnect] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  // After select(), connect once the provider is attached.
  useEffect(() => {
    if (!pendingConnect || !wallet || connected || connecting) return;
    setPendingConnect(false);
    connect().catch((e: unknown) => setConnectError(e instanceof Error ? e.message : 'Connection failed'));
  }, [pendingConnect, wallet, connected, connecting, connect]);

  const sessionWallet = me?.wallet ?? null;
  // One address has two legal spellings, so the session is compared case-insensitively.
  const sessionMatches = sessionWallet !== null && sameAddress(sessionWallet, publicKey);

  const pick = (rdns: string) => {
    setConnectError(null);
    setOpen(false);
    select(rdns);
    setPendingConnect(true);
  };

  const doSwitch = async () => {
    setConnectError(null);
    setSwitching(true);
    try {
      await switchNetwork();
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'Could not switch network');
    } finally {
      setSwitching(false);
    }
  };

  const doSignIn = async () => {
    if (!publicKey) {
      setConnectError('Connect a wallet first');
      return;
    }
    clearError();
    await signIn(publicKey, signMessage);
  };

  const doSignOut = async () => {
    setOpen(false);
    await signOut();
    await disconnect().catch(() => undefined);
  };

  const label = connecting || status === 'signing' ? (connecting ? 'CONNECTING…' : 'SIGNING…') : null;

  if (sessionMatches && sessionWallet) {
    return (
      <div className="wallet-wrap" ref={ref}>
        <button type="button" className="wallet-btn connected" onClick={() => setOpen((o) => !o)}>
          <b>{shortKey(sessionWallet)}</b>
        </button>
        {open && (
          <div className="wallet-menu">
            <div className="wm-note">{wallet?.name.toUpperCase() ?? 'WALLET'}</div>
            <MyAgentsLink onGo={() => setOpen(false)} />
            <button type="button" onClick={() => void doSignOut()}>SIGN OUT</button>
          </div>
        )}
      </div>
    );
  }

  // Connected, but the wallet is pointed at another network. A signature made here would pay on a
  // chain this deployment never reads, so the only thing on offer is moving the wallet.
  if (connected && wrongNetwork) {
    return (
      <div className="wallet-wrap" ref={ref}>
        <button type="button" className="wallet-btn" disabled={switching} onClick={() => void doSwitch()}>
          {switching ? 'SWITCHING…' : `SWITCH TO ${chain.name.toUpperCase()}`}
        </button>
        <button type="button" className="wallet-btn connected" style={{ marginLeft: 6 }} onClick={() => setOpen((o) => !o)} aria-label="wallet menu">⋯</button>
        {open && (
          <div className="wallet-menu">
            <button type="button" onClick={() => { setOpen(false); void disconnect(); }}>DISCONNECT</button>
          </div>
        )}
        {connectError && (
          <div className="wallet-menu">
            <div className="wm-note wm-err">{connectError}</div>
          </div>
        )}
      </div>
    );
  }

  if (connected && publicKey) {
    return (
      <div className="wallet-wrap" ref={ref}>
        <button type="button" className="wallet-btn" disabled={label !== null} onClick={() => void doSignIn()}>
          {label ?? `SIGN IN · ${shortKey(publicKey)}`}
        </button>
        <button type="button" className="wallet-btn connected" style={{ marginLeft: 6 }} onClick={() => setOpen((o) => !o)} aria-label="wallet menu">⋯</button>
        {open && (
          <div className="wallet-menu">
            <button type="button" onClick={() => { setOpen(false); void disconnect(); }}>DISCONNECT</button>
          </div>
        )}
        {(error ?? connectError) && (
          <div className="wallet-menu">
            <div className="wm-note wm-err">{error ?? connectError}</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="wallet-wrap" ref={ref}>
      <button type="button" className="wallet-btn" disabled={label !== null} onClick={() => setOpen((o) => !o)}>
        {label ?? 'CONNECT WALLET'}
      </button>
      {open && (
        <div className="wallet-menu">
          {/* EIP-6963: a wallet that is not installed never announces itself, so this list is what
              this browser actually has — there is no "install me" row to render any more. */}
          {wallets.length === 0 && <div className="wm-note">NO BROWSER WALLET DETECTED</div>}
          {wallets.map((w) => (
            <button type="button" key={w.rdns} onClick={() => pick(w.rdns)}>
              <span>{w.name.toUpperCase()}</span>
              <span className="dim">DETECTED</span>
            </button>
          ))}
          {googleAuth && (
            <button type="button" className="wm-google" onClick={() => { window.location.href = '/api/auth/google/start'; }}>
              <span>SIGN IN WITH GOOGLE</span>
            </button>
          )}
          <Link className="wm-link" to="/claim" onClick={() => setOpen(false)}>I HAVE A CLAIM CODE</Link>
          {(error ?? connectError) && <div className="wm-note wm-err">{error ?? connectError}</div>}
        </div>
      )}
    </div>
  );
}

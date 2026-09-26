// /launch — launch a Pons coin whose creator tax funds a fresh AI. The dev's own wallet signs the
// factory call and pays Pons's fee; the AI's wallet is written in as the fee recipient. In memory
// mode one SIMULATE LAUNCH button stands in for the wallet and the block, as SIMULATE PAYMENT does
// on the buy flow.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatEther } from 'viem';
import type { ImageUploadResponse, LaunchPrepareRequest, StrategyPreset } from '@vantra/shared';
import { SANDBOX_STRATEGIES, STRATEGY_PRESETS, sameAddress } from '@vantra/shared';
import { api } from '../api/client';
import { Panel } from '../components/Panel';
import { WalletButton } from '../components/WalletButton';
import { LogoPicker } from '../components/launchpad/LogoPicker';
import { StrategyPicker, INSTRUCTIONS_MAX } from '../components/launchpad/StrategyPicker';
import { TaxLadder } from '../components/launchpad/TaxLadder';
import { fmtTax } from '../components/launchpad/launchFormat';
import {
  readPending, useLaunchFlow, writePending, type LaunchFlow, type LaunchStep, type PendingLaunch,
} from '../components/launchpad/useLaunchFlow';
import { shortKey } from '../lib/format';
import { useWallet } from '../providers/WalletProvider';
import { useAppStore } from '../store/app';
import { useWalletStore } from '../store/wallet';

// Mirrors the server's zod rules for POST /api/launches, so the button never offers a doomed request.
const NAME_MAX = 32;
const TICKER_RE = /^[A-Z0-9]{2,10}$/;
const TICKER_MAX = 10;
const DESCRIPTION_MAX = 500;
const URL_MAX = 300;
const HANDLE_RE = /^@?[A-Za-z0-9_]{1,32}$/;
const DEFAULT_TAX_BPS = 500;
/** Long enough to read "LAUNCHED" before the coin's page replaces this one. */
const REDIRECT_MS = 900;

interface Form {
  name: string;
  ticker: string;
  description: string;
  logo: ImageUploadResponse | null;
  website: string;
  twitter: string;
  telegram: string;
  taxBps: number;
  strategy: StrategyPreset | null;
  instructions: string;
}

const EMPTY: Form = {
  name: '', ticker: '', description: '', logo: null, website: '', twitter: '', telegram: '',
  taxBps: DEFAULT_TAX_BPS, strategy: null, instructions: '',
};

function isHttpUrl(s: string, schemes: readonly string[]): boolean {
  if (s.length > URL_MAX) return false;
  try {
    return schemes.includes(new URL(s).protocol);
  } catch {
    return false;
  }
}

/** Per-field problems with what was typed. Empty optional fields are fine and absent here. */
function fieldErrors(f: Form): Partial<Record<keyof Form, string>> {
  const out: Partial<Record<keyof Form, string>> = {};
  const ticker = f.ticker.trim();
  if (ticker && !TICKER_RE.test(ticker)) out.ticker = '2–10 letters or digits.';
  const site = f.website.trim();
  if (site && !isHttpUrl(site, ['http:', 'https:'])) out.website = 'A full http(s) URL.';
  const x = f.twitter.trim();
  if (x && !HANDLE_RE.test(x) && !isHttpUrl(x, ['https:'])) out.twitter = 'An @handle or a full https URL.';
  const tg = f.telegram.trim();
  if (tg && !HANDLE_RE.test(tg) && !isHttpUrl(tg, ['https:'])) out.telegram = 'An @handle or a full https URL.';
  return out;
}

const orNull = (s: string): string | null => (s.trim() === '' ? null : s.trim());

export default function Launch() {
  const navigate = useNavigate();
  const stats = useAppStore((s) => s.stats);
  const payments = useAppStore((s) => s.payments);
  const simulate = payments?.simulateEnabled === true;
  const { flow, feeWei, start, confirm, reset } = useLaunchFlow({ simulate });
  const [form, setForm] = useState<Form>(EMPTY);
  const [logoBusy, setLogoBusy] = useState(false);
  const signedIn = useAppStore((s) => s.me) !== null;
  // Without a code sandbox the code-running presets are not offered; one picked before health answered
  // is dropped rather than sent (the server refuses it either way).
  const noSandbox = useAppStore((s) => s.sandbox) === 'none';
  const strategy = noSandbox && form.strategy !== null && SANDBOX_STRATEGIES.includes(form.strategy) ? null : form.strategy;

  const edit = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    if (flow.kind === 'failed') reset();
  };

  const errors = useMemo(() => fieldErrors(form), [form]);
  const signer = useSigner(simulate);

  const missing = useMemo((): string | null => {
    if (form.name.trim() === '') return 'Name the coin.';
    if (form.ticker.trim() === '') return 'Give it a ticker.';
    if (Object.keys(errors).length > 0) return 'Fix the highlighted fields.';
    if (logoBusy) return 'Wait for the logo to finish uploading.';
    if (strategy === null && form.instructions.trim() === '') return 'Pick a strategy or write instructions.';
    return null;
  }, [form, errors, strategy, logoBusy]);

  const body = (): LaunchPrepareRequest => ({
    name: form.name.trim(),
    ticker: form.ticker.trim().toUpperCase(),
    description: form.description.trim(),
    logoImageId: form.logo?.id ?? null,
    website: orNull(form.website),
    twitter: orNull(form.twitter),
    telegram: orNull(form.telegram),
    creatorTaxBps: form.taxBps,
    strategy,
    instructions: orNull(form.instructions),
  });

  const busy = flow.kind === 'running' || flow.kind === 'done';
  const blocked = missing ?? signer.blocker;

  const launch = () => {
    if (blocked !== null || busy) return;
    void start(body());
  };

  const retry = () => {
    if (flow.kind !== 'failed') return;
    if (flow.retry === 'reconfirm' && flow.launchId && flow.hash) void confirm(flow.launchId, flow.hash);
    else launch();
  };

  useEffect(() => {
    if (flow.kind !== 'done') return;
    const id = window.setTimeout(() => navigate(`/a/${flow.launch.agentId}`), REDIRECT_MS);
    return () => window.clearTimeout(id);
  }, [flow, navigate]);

  const strategyLabel = strategy ? STRATEGY_PRESETS.find((p) => p.id === strategy)?.label : null;
  const ticker = form.ticker.trim() ? `$${form.ticker.trim().toUpperCase()}` : '$—';

  return (
    <div className="lx">
      <div className="page-head">
        <h1 className="page-title">LAUNCH A COIN</h1>
        <p className="page-sub">
          Launch a coin on Pons. Its creator tax is wired, at launch, to a fresh AI&apos;s own wallet. You tell the AI how
          to try to make money; it lives on the fees, and whatever it holds above what it needs to survive it spends buying
          back your coin and burning it. You pay only Pons&apos;s launch fee — VANTRA takes no cut, ever.
        </p>
      </div>

      <ResumeLaunch onConfirm={(p) => void confirm(p.launchId, p.txSig)} busy={busy} />

      <div className="lx-grid">
        <div className="lx-main">
          <Panel title="01 · THE COIN" right="ON PONS">
            <div className="lx-fields">
              <Field label="NAME" count={`${form.name.length}/${NAME_MAX}`}>
                <input
                  className="finput"
                  value={form.name}
                  maxLength={NAME_MAX}
                  placeholder="Moonlight Operator"
                  onChange={(e) => edit({ name: e.target.value })}
                />
              </Field>
              <Field label="TICKER" error={errors.ticker}>
                <input
                  className="finput lx-ticker"
                  value={form.ticker}
                  maxLength={TICKER_MAX}
                  placeholder="MOON"
                  autoCapitalize="characters"
                  spellCheck={false}
                  onChange={(e) => edit({ ticker: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, TICKER_MAX) })}
                />
              </Field>
              <Field label="DESCRIPTION" wide count={`${form.description.length}/${DESCRIPTION_MAX}`}>
                <textarea
                  className="finput"
                  rows={3}
                  value={form.description}
                  maxLength={DESCRIPTION_MAX}
                  placeholder="What this coin is, in a sentence or two."
                  onChange={(e) => edit({ description: e.target.value })}
                />
              </Field>
              <LogoPicker logo={form.logo} signedIn={signedIn} onLogo={(logo) => edit({ logo })} onBusy={setLogoBusy} />
              <Field label="WEBSITE" optional error={errors.website}>
                <input
                  className="finput"
                  value={form.website}
                  placeholder="https://"
                  spellCheck={false}
                  onChange={(e) => edit({ website: e.target.value })}
                />
              </Field>
              <Field label="X" optional error={errors.twitter}>
                <input
                  className="finput"
                  value={form.twitter}
                  placeholder="@handle"
                  spellCheck={false}
                  onChange={(e) => edit({ twitter: e.target.value })}
                />
              </Field>
              <Field label="TELEGRAM" optional error={errors.telegram}>
                <input
                  className="finput"
                  value={form.telegram}
                  placeholder="@group or https://t.me/…"
                  spellCheck={false}
                  onChange={(e) => edit({ telegram: e.target.value })}
                />
              </Field>
            </div>
          </Panel>

          <Panel title="02 · CREATOR TAX" right="THE AI'S FUEL">
            <TaxLadder taxBps={form.taxBps} onTax={(taxBps) => edit({ taxBps })} />
          </Panel>

          <Panel title="03 · HOW IT MAKES MONEY" right="STRATEGY">
            <StrategyPicker
              strategy={strategy}
              codeStrategies={!noSandbox}
              instructions={form.instructions}
              onStrategy={(picked) => edit({ strategy: picked })}
              onInstructions={(instructions) => edit({ instructions: instructions.slice(0, INSTRUCTIONS_MAX) })}
            />
          </Panel>
        </div>

        <aside className="lx-side">
          <Panel title="04 · LAUNCH" right={simulate ? 'SIMULATION' : (stats?.chain.cluster ?? '')}>
            <div className="lx-sum">
              <Row k="COIN" v={form.name.trim() ? `${ticker} · ${form.name.trim()}` : ticker} />
              <Row k="CREATOR TAX" v={`${fmtTax(form.taxBps)} → the AI's wallet`} />
              <Row k="STRATEGY" v={strategyLabel ?? (form.instructions.trim() ? 'YOUR INSTRUCTIONS' : '—')} />
              <Row k="AI STARTS" v="DORMANT · wakes on its first fees" />
              <Row k="SIGNER" v={signer.label} />
              <Row
                k="YOU PAY"
                v={simulate ? 'nothing — simulated' : feeWei !== null ? `${formatEther(feeWei)} ETH Pons fee + gas` : "Pons's launch fee + gas"}
              />
              <Row k="VANTRA'S CUT" v="0%" />
            </div>

            <div className="lx-trust">
              <div className="lx-trust-t">THE GUARANTEE</div>
              <p>
                Once launched, only the AI&apos;s wallet can redirect its fees — not the dev, not us. The Pons factory lets
                no one but the current fee recipient move them, and VANTRA never makes that call.
              </p>
              <p className="faint">
                You own the agent: you can message it, steer it and switch its model within what its fees unlock. You can
                never withdraw its money or shut it down.
              </p>
            </div>

            {signer.control}

            {simulate && (
              <div className="alert warn lx-sim">
                <span>
                  <b>SIMULATION — nothing touches a chain.</b> This deployment runs the in-memory chain; the launch and its
                  fees are fake.
                </span>
              </div>
            )}

            <FlowSteps flow={flow} simulate={simulate} />

            {flow.kind === 'failed' && (
              <div className="alert err lx-fail">
                <span>
                  <b>{STEP_LABEL[flow.step]} FAILED</b> — {flow.message}
                </span>
              </div>
            )}

            {flow.kind === 'failed' ? (
              <div className="lx-actions">
                <button type="button" className="btn-primary lx-go" disabled={blocked !== null && flow.retry !== 'reconfirm'} onClick={retry}>
                  {RETRY_LABEL[flow.retry]}
                </button>
                <button type="button" className="btn-ghost" onClick={reset}>
                  EDIT
                </button>
              </div>
            ) : (
              <button type="button" className="btn-primary lx-go" disabled={blocked !== null || busy} onClick={launch}>
                {busyLabel(flow) ?? (simulate ? 'SIMULATE LAUNCH' : `LAUNCH ${ticker} · SIGN IN WALLET`)}
              </button>
            )}
            {blocked !== null && flow.kind === 'idle' && <p className="form-hint lx-why">{blocked}</p>}
            {flow.kind === 'done' && (
              <p className="form-hint lx-why">
                Live. Opening <Link to={`/a/${flow.launch.agentId}`}>{flow.launch.agentName}</Link>…
              </p>
            )}
          </Panel>
          <p className="note">
            Rather fund an agent yourself? <Link to="/buy">Buy one outright →</Link>
          </p>
        </aside>
      </div>
    </div>
  );
}

/* ---------- the signer ---------- */

interface Signer {
  /** Why the launch cannot be signed yet, or null when it can. */
  blocker: string | null;
  label: string;
  /** Whatever the dev has to do next to become a signer; null when nothing. */
  control: ReactNode;
}

/**
 * The session is the dev: its wallet is recorded as the launch's deployer. On a real chain the
 * connected wallet must also BE that session's wallet, on the right network, because it signs.
 */
function useSigner(simulate: boolean): Signer {
  const me = useAppStore((s) => s.me);
  const demo = useAppStore((s) => s.stats?.demo ?? null);
  const status = useWalletStore((s) => s.status);
  const error = useWalletStore((s) => s.error);
  const { connected, publicKey, wrongNetwork, walletClient, chain } = useWallet();

  if (!me) {
    if (demo) {
      return {
        blocker: 'Sign in with the demo wallet first.',
        label: 'not signed in',
        control: (
          <div className="lx-signer">
            <button
              type="button"
              className="btn-ghost"
              disabled={status === 'signing'}
              onClick={() => void useWalletStore.getState().signInDemo()}
            >
              {status === 'signing' ? 'SIGNING IN…' : 'SIGN IN WITH THE DEMO WALLET'}
            </button>
            {error && <span className="form-err">{error}</span>}
          </div>
        ),
      };
    }
    return {
      blocker: 'Connect the wallet that will sign the launch, then sign in.',
      label: 'not signed in',
      control: (
        <div className="lx-signer">
          <WalletButton />
          <span className="form-hint">Connect and sign in with the wallet that will sign the launch.</span>
        </div>
      ),
    };
  }

  if (me.ownerKind !== 'wallet' || !me.wallet) {
    return {
      blocker: 'A launch is signed by a wallet. Sign out of this claim/Google session and connect one.',
      label: 'no wallet',
      control: (
        <div className="lx-signer">
          <WalletButton />
        </div>
      ),
    };
  }

  const who = shortKey(me.wallet, 6, 4);
  if (simulate) return { blocker: null, label: `${who} · simulated`, control: null };

  if (!connected || !publicKey || !walletClient) {
    return {
      blocker: `Connect ${who}, the wallet you are signed in with.`,
      label: who,
      control: (
        <div className="lx-signer">
          <WalletButton />
          <span className="form-hint">Your session is {who}. Connect that wallet to sign.</span>
        </div>
      ),
    };
  }
  if (!sameAddress(me.wallet, publicKey)) {
    return {
      blocker: `The connected wallet ${shortKey(publicKey)} is not ${who}, the one you are signed in with.`,
      label: who,
      control: (
        <div className="lx-signer">
          <WalletButton />
          <span className="form-hint">Switch the wallet to {who}, or sign in again with {shortKey(publicKey)}.</span>
        </div>
      ),
    };
  }
  if (wrongNetwork) {
    return {
      blocker: `Switch the wallet to ${chain.name}.`,
      label: who,
      control: (
        <div className="lx-signer">
          <WalletButton />
        </div>
      ),
    };
  }
  return { blocker: null, label: `${who} · ${chain.name}`, control: null };
}

/* ---------- progress ---------- */

const STEP_LABEL: Record<LaunchStep, string> = {
  prepare: 'PREPARE',
  sign: 'SIGN',
  block: 'BLOCK',
  confirm: 'VERIFY',
  simulate: 'SIMULATE',
};

const STEP_NOTE: Record<LaunchStep, string> = {
  prepare: 'create the AI and its wallet, build the Pons call',
  sign: 'your wallet signs and pays the launch fee',
  block: 'wait for the transaction to land',
  confirm: 'VANTRA checks the chain: fee recipient = the AI',
  simulate: 'fake the launch on the in-memory chain',
};

const RETRY_LABEL: Record<'restart' | 'resign' | 'reconfirm', string> = {
  restart: 'TRY AGAIN',
  resign: 'RETRY',
  reconfirm: 'CONFIRM AGAIN',
};

function busyLabel(flow: LaunchFlow): string | null {
  if (flow.kind === 'done') return 'LAUNCHED';
  if (flow.kind !== 'running') return null;
  switch (flow.step) {
    case 'prepare':
      return 'PREPARING…';
    case 'sign':
      return 'SIGN IN YOUR WALLET…';
    case 'block':
      return 'WAITING FOR THE BLOCK…';
    case 'confirm':
      return 'VERIFYING ON CHAIN…';
    case 'simulate':
      return 'SIMULATING…';
  }
}

function FlowSteps({ flow, simulate }: { flow: LaunchFlow; simulate: boolean }) {
  if (flow.kind === 'idle') return null;
  const steps: LaunchStep[] = simulate ? ['prepare', 'simulate'] : ['prepare', 'sign', 'block', 'confirm'];
  const at = flow.kind === 'done' ? steps.length : steps.indexOf(flow.step);
  const hash = flow.kind === 'running' || flow.kind === 'failed' ? flow.hash : null;
  return (
    <ol className="lx-steps">
      {steps.map((s, i) => {
        const state =
          i < at ? 'done' : i > at ? 'todo' : flow.kind === 'failed' ? 'fail' : flow.kind === 'running' ? 'now' : 'done';
        return (
          <li key={s} className={`is-${state}`}>
            <span className="lx-step-m" aria-hidden="true">
              {state === 'done' ? '✓' : state === 'fail' ? '✗' : state === 'now' ? '›' : '·'}
            </span>
            <span className="lx-step-k">{STEP_LABEL[s]}</span>
            <span className="lx-step-n">{STEP_NOTE[s]}</span>
          </li>
        );
      })}
      {hash && (
        <li className="lx-hash">
          TX <code>{shortKey(hash, 10, 8)}</code>
        </li>
      )}
    </ol>
  );
}

/* ---------- a signed launch that was never confirmed ---------- */

function ResumeLaunch({ onConfirm, busy }: { onConfirm: (p: PendingLaunch) => void; busy: boolean }) {
  const [pending, setPending] = useState<PendingLaunch | null>(() => readPending());
  const [state, setState] = useState<'checking' | 'open' | 'gone'>('checking');

  useEffect(() => {
    if (!pending) return;
    let live = true;
    api
      .launch(pending.launchId)
      .then((l) => {
        if (!live) return;
        // Only a launch still waiting on its signature needs the dev; anything else is settled.
        if (l.state === 'awaiting_signature') setState('open');
        else {
          writePending(null);
          setState('gone');
        }
      })
      .catch(() => {
        if (live) setState('open');
      });
    return () => {
      live = false;
    };
  }, [pending]);

  if (!pending || state !== 'open') return null;
  return (
    <div className="alert warn lx-resume">
      <span>
        <b>UNCONFIRMED LAUNCH</b> — you signed ${pending.ticker} (tx {shortKey(pending.txSig, 8, 6)}) but it was never
        verified, so it is not listed yet.
      </span>
      <span className="spacer" />
      <button
        type="button"
        className="btn-primary"
        disabled={busy}
        onClick={() => {
          setPending(null);
          onConfirm(pending);
        }}
      >
        CONFIRM IT
      </button>
      <button type="button" className="btn-ghost" onClick={() => setPending(null)}>
        HIDE
      </button>
    </div>
  );
}

/* ---------- small pieces ---------- */

function Field({
  label, optional, wide, error, count, children,
}: {
  label: string;
  optional?: boolean;
  wide?: boolean;
  error?: string;
  count?: string;
  children: ReactNode;
}) {
  return (
    <label className={`lx-field${wide ? ' lx-field-wide' : ''}${error ? ' has-err' : ''}`}>
      <span className="lx-label">
        {label}
        {optional && <span className="faint"> · optional</span>}
        {count && <span className="lx-count">{count}</span>}
      </span>
      {children}
      {error && <span className="form-err">{error}</span>}
    </label>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="lx-row">
      <span className="lx-row-k">{k}</span>
      <span className="dots" />
      <span className="lx-row-v">{v}</span>
    </div>
  );
}

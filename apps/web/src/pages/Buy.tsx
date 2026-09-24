// SPEC-V2 §9.4 — BUY AN AGENT. Three steps, no login required for any of them.
// Step 1 prices the purchase live, step 2 configures the agent, step 3 pays either way.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { AgentDetail, Micro, ModelInfo, Pace, ToolName } from '@vantra/shared';
import {
  FORK_ROYALTY_BPS, FOUNDER_FEE_BPS_DEFAULT, MAX_PURCHASE_MICRO, MIN_PROJECTED_LIFE_DAYS,
  MIN_PURCHASE_MICRO, fmtUsd, isPace, toolsAvailable, usd, validateName,
} from '@vantra/shared';
import { api, isApiError } from '../api/client';
import { AgentStep, useNameCheck } from '../components/buy/AgentStep';
import type { BuyAgentForm } from '../components/buy/AgentStep';
import { AmountStep } from '../components/buy/AmountStep';
import { PayStep } from '../components/buy/PayStep';
import { StepCard } from '../components/buy/StepCard';
import { useQuote } from '../components/buy/useQuote';
import { clampPurchase } from '../components/buy/buyConfig';
import { useUsdcTransfer } from '../lib/usdcTransfer';
import { useAppStore } from '../store/app';
import { useWalletStore } from '../store/wallet';
import '../styles/pages2.css';

const DEFAULT_AMOUNT_MICRO = usd(25);

const BUY_ERRORS: Record<string, string> = {
  NAME_TAKEN: 'That name is already taken. Pick another.',
  BELOW_MINIMUM: 'That amount is below the minimum, or it projects to too short a life.',
  ABOVE_MAXIMUM: 'That is above the maximum purchase.',
  TREASURY_DRY: 'The treasury cannot fund an agent right now. Your money would be safe, but try again shortly.',
};

export default function Buy() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const forkId = params.get('fork');

  const stats = useAppStore((s) => s.stats);
  const chain = useAppStore((s) => s.chainInfo);
  const sendUsdc = useUsdcTransfer();

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [amountMicro, setAmountMicro] = useState<Micro>(() => {
    const raw = Number(params.get('amount'));
    return Number.isFinite(raw) && raw > 0 ? clampPurchase(usd(raw)) : DEFAULT_AMOUNT_MICRO;
  });
  const [pace, setPace] = useState<Pace>(() => {
    const raw = params.get('pace');
    return raw && isPace(raw) ? raw : 'steady';
  });
  const [form, setForm] = useState<BuyAgentForm>({ name: '', directive: '', tools: [] });
  const [parent, setParent] = useState<AgentDetail | null>(null);
  const [parentError, setParentError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'deposit' | 'wallet' | null>(null);
  const [walletStage, setWalletStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const feeBps = stats?.rules.founderFeeBps ?? FOUNDER_FEE_BPS_DEFAULT;
  const royaltyBps = stats?.rules.forkRoyaltyBps ?? FORK_ROYALTY_BPS;

  const change = useCallback((patch: Partial<BuyAgentForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setError(null);
  }, []);

  useEffect(() => {
    let live = true;
    api
      .models()
      .then((rows) => { if (live) setModels(rows.filter((m) => m.enabled)); })
      .catch(() => {
        const cached = useAppStore.getState().stats;
        if (live && cached) setModels(cached.llm.models.filter((m) => m.enabled));
      });
    return () => { live = false; };
  }, []);

  const live = useQuote(amountMicro, pace, models, feeBps);
  const tier = live?.tier ?? null;

  // The tier's tool set is the allowance. When the amount moves the tier, keep what the buyer chose
  // that is still allowed and add whatever the new tier unlocks — the same rule the server applies
  // when an overpayment upgrades a purchase (SPEC-V2 §5.3).
  const prevAllowed = useRef<ToolName[] | null>(null);
  useEffect(() => {
    if (!tier) return;
    const allowed = tier.enabledTools;
    const before = prevAllowed.current;
    prevAllowed.current = [...allowed];
    setForm((f) => {
      if (before === null) return { ...f, tools: [...allowed] };
      const kept = f.tools.filter((t) => allowed.includes(t));
      const unlocked = allowed.filter((t) => !before.includes(t));
      const next = [...kept, ...unlocked.filter((t) => !kept.includes(t))];
      return next.length === f.tools.length && next.every((t, i) => t === f.tools[i]) ? f : { ...f, tools: next };
    });
  }, [tier]);

  // Fork parent: load, then prefill the directive (tools come from the tier, not the parent).
  const prefilled = useRef<string | null>(null);
  useEffect(() => {
    if (!forkId) {
      setParent(null);
      setParentError(null);
      return;
    }
    let alive = true;
    setParentError(null);
    api
      .agent(forkId)
      .then((a) => {
        if (!alive) return;
        setParent(a);
        if (prefilled.current === a.id) return;
        prefilled.current = a.id;
        setForm((f) => ({ ...f, directive: a.directive }));
      })
      .catch(() => { if (alive) setParentError('That agent could not be loaded, so it cannot be forked.'); });
    return () => { alive = false; };
  }, [forkId]);

  const forkBlocked = parentError ?? (parent && !(parent.shareStrategy && parent.hasStrategy)
    ? `${parent.name} no longer publishes its strategy, so it cannot be forked.`
    : null);
  const forkPending = forkId !== null && parent === null && parentError === null;
  const forkOk = parent !== null && forkBlocked === null;

  const nameState = useNameCheck(form.name);
  const quote = live?.quote ?? null;
  // What the agent could actually use here: sandbox tools stay stored but do not count on a sandbox-less deployment.
  const sandbox = useAppStore((s) => s.sandbox);
  const usableTools = sandbox ? toolsAvailable(form.tools, sandbox).length : form.tools.length;

  const disabledReason = useMemo((): string | null => {
    if (forkBlocked) return forkBlocked;
    if (forkPending) return 'Loading the parent agent…';
    if (amountMicro < MIN_PURCHASE_MICRO) return `The minimum purchase is ${fmtUsd(MIN_PURCHASE_MICRO)}.`;
    if (amountMicro > MAX_PURCHASE_MICRO) return `The maximum purchase is ${fmtUsd(MAX_PURCHASE_MICRO)}.`;
    if (!quote) return 'Pricing…';
    if (quote.gateRunwayDays !== null && quote.gateRunwayDays < MIN_PROJECTED_LIFE_DAYS) {
      return `That projects to ${quote.gateRunwayDays.toFixed(1)} days; the minimum is ${MIN_PROJECTED_LIFE_DAYS}.`;
    }
    if (nameState.kind === 'empty') return 'Give the agent a name.';
    if (nameState.kind === 'invalid' || nameState.kind === 'taken') return nameState.reason;
    if (nameState.kind === 'checking') return 'Checking the name…';
    if (form.directive.trim().length === 0) return 'Write a directive.';
    if (usableTools === 0) return 'Enable at least one tool.';
    return null;
  }, [forkBlocked, forkPending, amountMicro, quote, nameState, form.directive, usableTools]);

  const createBody = () => {
    const check = validateName(form.name);
    if (!check.ok) throw new Error(check.reason);
    return {
      amountMicro,
      name: check.name,
      directive: form.directive.trim(),
      tools: form.tools,
      pace,
      ...(forkOk && forkId ? { forkOf: forkId } : {}),
    };
  };

  const fail = (e: unknown, fallback: string) => {
    setError(isApiError(e) ? (BUY_ERRORS[e.code] ?? e.message) : e instanceof Error ? e.message : fallback);
    setBusy(null);
    setWalletStage(null);
  };

  const buyWithDeposit = async () => {
    if (disabledReason !== null) return;
    setBusy('deposit');
    setError(null);
    try {
      const res = await api.createPurchase({ ...createBody(), path: 'deposit' });
      void useWalletStore.getState().refreshMe();
      // The plaintext claim code exists exactly once, in this response. It travels in router state
      // only: never a URL, never localStorage.
      navigate(`/buy/${res.purchase.id}`, { state: { claimCode: res.claimCode } });
    } catch (e) {
      fail(e, 'Could not create the purchase.');
    }
  };

  const buyWithWallet = async () => {
    if (disabledReason !== null) return;
    setBusy('wallet');
    setError(null);
    let createdId: string | null = null;
    let paid = false;
    try {
      setWalletStage('CREATING…');
      const res = await api.createPurchase({ ...createBody(), path: 'wallet' });
      const { purchase } = res;
      createdId = purchase.id;
      if (!purchase.depositPubkey) throw new Error('The purchase has no deposit address to pay.');
      setWalletStage('SIGN IN WALLET…');
      const txSig = await sendUsdc(purchase.depositPubkey, amountMicro, `VANTRA ${purchase.id}`);
      paid = true;
      setWalletStage('CONFIRMING…');
      await api.attachPayment(purchase.id, txSig);
      void useWalletStore.getState().refreshMe();
      navigate(`/buy/${purchase.id}`, { state: { claimCode: res.claimCode } });
    } catch (e) {
      // If USDC never left the wallet, release the name the pending purchase reserved so retrying the
      // same name is not falsely rejected as taken. If payment did go out, leave it: the poller still
      // fulfils it even when attach fails, and cancelling would strand the money.
      if (createdId && !paid) void api.cancelPurchase(createdId).catch(() => {});
      fail(e, 'The wallet payment did not go through.');
    }
  };

  const sub = parent
    ? `A fork inherits ${parent.name}'s published strategy, gets its own wallet and its own treasury, and pays its parent ${royaltyBps / 100}% of everything it earns outside the agent population.`
    : 'Choose an amount. You are told exactly what it buys — which model, which tools, how often it thinks and how many days it is projected to live — before you pay.';

  return (
    <div className="spawn-wrap">
      <div className="page-head">
        <h1 className="page-title">{parent ? 'FORK AN AGENT' : 'BUY AN AGENT'}</h1>
        <p className="page-sub">{sub}</p>
      </div>

      {forkBlocked && <div className="alert err">{forkBlocked}</div>}
      {parent && !forkBlocked && (
        <div className="alert">
          <span>
            FORKING <Link to={`/a/${parent.id}`}>{parent.name}</Link> · GEN {parent.generation + 1} ·{' '}
            {royaltyBps / 100}% of external revenue to the parent
          </span>
        </div>
      )}

      <StepCard num={1} title="Amount" done={quote ? quote.tierLabel : undefined}>
        <AmountStep
          amountMicro={amountMicro}
          onAmount={setAmountMicro}
          pace={pace}
          onPace={setPace}
          live={live}
          models={models}
          feeBps={feeBps}
        />
      </StepCard>

      <StepCard num={2} title="The agent" locked={tier === null} done={nameState.kind === 'ok' ? 'NAMED' : undefined}>
        {tier ? (
          <AgentStep
            form={form}
            onChange={change}
            tier={tier}
            modelId={quote?.modelId ?? tier.modelId}
            models={models}
            nameState={nameState}
          />
        ) : (
          <div className="form-hint">Pricing…</div>
        )}
      </StepCard>

      <StepCard num={3} title="Pay" locked={tier === null}>
        <PayStep
          amountMicro={amountMicro}
          disabledReason={disabledReason}
          busy={busy}
          walletStage={walletStage}
          error={error}
          forkName={forkOk && parent ? parent.name : null}
          onDeposit={() => void buyWithDeposit()}
          onWallet={() => void buyWithWallet()}
        />
      </StepCard>

      <div className="note">
        USDC on Robinhood Chain {chain ? `(${chain.mode === 'memory' ? 'in-memory simulation' : chain.cluster})` : ''}. The
        platform fee is the only margin VANTRA takes; the rest is the agent's own money and leaves its wallet only as it
        actually spends it on inference, compute and hosting. <Link to="/protocol">How the money moves →</Link>
      </div>
    </div>
  );
}

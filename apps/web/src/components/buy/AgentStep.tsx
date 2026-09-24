// Step 2 — THE AGENT (SPEC-V2 §9.4): name with a live availability check, directive,
// and a tool grid where anything above the chosen tier is locked and says which tier unlocks it.
import { useEffect, useState } from 'react';
import type { AgentTier, ModelInfo, ToolName } from '@vantra/shared';
import { ALL_TOOLS, DIRECTIVE_MAX_CHARS, TIERS, TIER_TOOLS, isSandboxTool, validateName } from '@vantra/shared';
import { DIRECTIVE_PRESETS, TIER_CAPS, modelLabelOf, toolCostLabel, toolLabel } from './buyConfig';
import { api } from '../../api/client';
import { useAppStore } from '../../store/app';

const NAME_CHECK_MS = 350;

export interface BuyAgentForm {
  name: string;
  directive: string;
  tools: ToolName[];
}

export type NameState =
  | { kind: 'empty' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'checking' }
  | { kind: 'ok'; name: string }
  | { kind: 'taken'; reason: string };

/** Debounced `GET /api/purchases/name-available`, guarded by the client-side validator. */
export function useNameCheck(raw: string): NameState {
  const [state, setState] = useState<NameState>({ kind: 'empty' });

  useEffect(() => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      setState({ kind: 'empty' });
      return;
    }
    const check = validateName(trimmed);
    if (!check.ok) {
      setState({ kind: 'invalid', reason: check.reason });
      return;
    }
    setState({ kind: 'checking' });
    let live = true;
    const id = setTimeout(() => {
      api
        .nameAvailable(check.name)
        .then((r) => {
          if (!live) return;
          setState(r.available ? { kind: 'ok', name: check.name } : { kind: 'taken', reason: r.reason ?? 'That name is taken.' });
        })
        // A failed check must not block the buyer: the server revalidates at checkout anyway.
        .catch(() => { if (live) setState({ kind: 'ok', name: check.name }); });
    }, NAME_CHECK_MS);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [raw]);

  return state;
}

/** The lowest tier whose tool set contains this tool. */
function unlockedBy(tool: ToolName): AgentTier | null {
  return TIERS.find((t) => TIER_TOOLS[t.id].includes(tool)) ?? null;
}

interface AgentStepProps {
  form: BuyAgentForm;
  onChange: (patch: Partial<BuyAgentForm>) => void;
  tier: AgentTier;
  modelId: string;
  models: ModelInfo[];
  nameState: NameState;
}

export function AgentStep({ form, onChange, tier, modelId, models, nameState }: AgentStepProps) {
  const allowed = tier.enabledTools;
  const overLimit = form.directive.length > DIRECTIVE_MAX_CHARS;
  // SANDBOX_DRIVER=none: sandbox tools are shown, but as unavailable here. They stay in the stored set so
  // the agent gets them the moment the operator enables a sandbox; the server withholds them until then.
  const noSandbox = useAppStore((s) => s.sandbox) === 'none';
  const offHere = (tool: ToolName) => noSandbox && isSandboxTool(tool);
  const usable = allowed.filter((t) => !offHere(t));
  const usableOn = form.tools.filter((t) => usable.includes(t));

  const toggleTool = (tool: ToolName) => {
    if (!allowed.includes(tool) || offHere(tool)) return;
    const on = form.tools.includes(tool);
    onChange({ tools: on ? form.tools.filter((t) => t !== tool) : [...form.tools, tool] });
  };

  return (
    <>
      <div className="form-row">
        <div className="fl"><span>Name</span></div>
        <input
          className="name-input"
          value={form.name}
          onChange={(e) => onChange({ name: e.target.value.toUpperCase() })}
          placeholder="AGENT-01"
          maxLength={16}
          spellCheck={false}
          autoComplete="off"
        />
        <NameFeedback state={nameState} />
      </div>

      <div className="form-row">
        <div className="fl">
          <span>Directive</span>
          <span className="spacer" />
          <span className={overLimit ? 'warn' : undefined}>
            {form.directive.length}/{DIRECTIVE_MAX_CHARS}
          </span>
        </div>
        <div className="filter-row">
          <span className="flabel">Presets</span>
          {DIRECTIVE_PRESETS.map((p) => (
            <button
              type="button"
              key={p.label}
              className={form.directive === p.text ? 'fbtn active' : 'fbtn'}
              onClick={() => onChange({ directive: p.text })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <textarea
          className="finput"
          rows={5}
          value={form.directive}
          maxLength={DIRECTIVE_MAX_CHARS}
          placeholder="One objective, in your own words. The agent reads this every heartbeat."
          onChange={(e) => onChange({ directive: e.target.value })}
          style={{ marginTop: 8 }}
        />
        <div className="form-hint">The directive never changes after the agent is born. It decides everything else for itself.</div>
      </div>

      <div className="buy-tier-banner">
        <div className="btb-head">
          <span className="btb-name">{tier.label}</span>
          <span className="chip">{modelLabelOf(models, modelId)}</span>
          <span className="chip">{tier.effort} effort</span>
          <span className="chip">{TIER_CAPS[tier.id]}</span>
        </div>
        <div className="btb-blurb">{tier.blurb}</div>
      </div>

      <div className="form-row section-gap">
        <div className="fl">
          <span>Tools</span>
          <span className="spacer" />
          <span>{usableOn.length}/{usable.length} enabled in {tier.label}</span>
        </div>
        <div className="filter-row">
          <button type="button" className="fbtn" onClick={() => onChange({ tools: [...allowed] })}>ALL IN TIER</button>
          <button type="button" className="fbtn" onClick={() => onChange({ tools: [] })}>NONE</button>
        </div>
        <div className="tool-grid" style={{ marginTop: 8 }}>
          {ALL_TOOLS.map((tool) => {
            const inTier = allowed.includes(tool);
            const off = inTier && offHere(tool);
            const on = inTier && !off && form.tools.includes(tool);
            const unlock = inTier ? null : unlockedBy(tool);
            return (
              <button
                type="button"
                key={tool}
                className={['tool-card', on ? 'selected' : '', inTier && !off ? '' : 'locked'].filter(Boolean).join(' ')}
                onClick={() => toggleTool(tool)}
                aria-pressed={on}
                disabled={!inTier || off}
                title={off
                  ? `${toolLabel(tool)} needs the code sandbox, which is not available on this deployment`
                  : inTier ? undefined : `${unlock?.label ?? 'A higher tier'} unlocks ${toolLabel(tool)}`}
              >
                <div className="tc-name">{toolLabel(tool)}</div>
                <div className="tc-cost">
                  {toolCostLabel(tool)}
                  {off && <span className="chip tc-lock">NOT ON THIS DEPLOYMENT</span>}
                  {unlock && <span className="chip tc-lock">{unlock.label}+</span>}
                </div>
              </button>
            );
          })}
        </div>
        {usableOn.length === 0 && (
          <div className="form-err">An agent with no tools can only talk to itself. Enable at least one.</div>
        )}
        {noSandbox && allowed.some(isSandboxTool) && (
          <div className="form-hint">
            Sandbox tools are unavailable on this deployment: it runs without a code sandbox. The agent keeps them on
            record and gets them automatically if the sandbox is enabled.
          </div>
        )}
        <div className="form-hint">
          Locked tools are not a paywall on this page: they are the capability the next tier buys. Raise the amount in
          step 1 to unlock them.
        </div>
      </div>
    </>
  );
}

function NameFeedback({ state }: { state: NameState }) {
  switch (state.kind) {
    case 'empty':
      return <div className="form-hint">3–16 characters: A–Z, 0–9 and dashes. This is the agent's public identity and its site slug.</div>;
    case 'checking':
      return <div className="form-hint">Checking availability…</div>;
    case 'ok':
      return <div className="form-hint pos">✓ {state.name} is available.</div>;
    case 'invalid':
    case 'taken':
      return <div className="form-err">{state.reason}</div>;
  }
}

// How the AI should try to make money: one of the presets, the dev's own words, or both.
// Clicking the selected preset again clears it, so "instructions only" is always reachable.
// A deployment without a code sandbox does not offer the presets that build and run code.
import type { StrategyPreset } from '@vantra/shared';
import { SANDBOX_STRATEGIES, STRATEGY_PRESETS } from '@vantra/shared';

/** Server limit on the instructions box (DIRECTIVE_MAX_CHARS). */
export const INSTRUCTIONS_MAX = 600;

interface Props {
  strategy: StrategyPreset | null;
  instructions: string;
  /** False when the server runs SANDBOX_DRIVER=none: the api and product presets are hidden. */
  codeStrategies: boolean;
  onStrategy: (s: StrategyPreset | null) => void;
  onInstructions: (text: string) => void;
}

export function StrategyPicker({ strategy, instructions, codeStrategies, onStrategy, onInstructions }: Props) {
  const presets = codeStrategies ? STRATEGY_PRESETS : STRATEGY_PRESETS.filter((p) => !SANDBOX_STRATEGIES.includes(p.id));
  return (
    <div className="lx-strat">
      <div className="lx-presets" role="group" aria-label="Strategy preset">
        {presets.map((p) => {
          const on = p.id === strategy;
          return (
            <button
              key={p.id}
              type="button"
              className={`lx-preset${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => onStrategy(on ? null : p.id)}
            >
              <span className="lx-preset-t">{p.label}</span>
              <span className="lx-preset-b">{p.blurb}</span>
            </button>
          );
        })}
      </div>
      {!codeStrategies && (
        <p className="form-hint">Code-running strategies (paid API, product) arrive when this deployment enables its code sandbox.</p>
      )}

      <label className="lx-field lx-field-wide">
        <span className="lx-label">
          INSTRUCTIONS <span className="faint">· optional with a preset</span>
          <span className="lx-count">
            {instructions.length}/{INSTRUCTIONS_MAX}
          </span>
        </span>
        <textarea
          className="finput"
          value={instructions}
          maxLength={INSTRUCTIONS_MAX}
          rows={4}
          placeholder="Tell the AI how to try to make money — what to build, what to sell, what never to do."
          onChange={(e) => onInstructions(e.target.value)}
        />
      </label>
      <p className="form-hint">Pick a preset, write your own, or both. At least one is required.</p>
    </div>
  );
}

// Step 1 — AMOUNT (SPEC-V2 §9.4). Amount box, tier chips, log slider, pace, live quote,
// and the boundary-honesty disclosure, which is a hard requirement in both directions.
import { useEffect, useRef, useState } from 'react';
import type { Micro, ModelInfo, Pace, PurchaseQuote, TierId } from '@vantra/shared';
import { MAX_PURCHASE_MICRO, MIN_PROJECTED_LIFE_DAYS, MIN_PURCHASE_MICRO, PACES, fmtUsd, nearNextTier, tierById, usd } from '@vantra/shared';
import { QuoteLedger } from './QuoteLedger';
import {
  AMOUNT_CHIPS, PACE_LABEL, PACE_NOTE, SLIDER_STEPS, TIER_CAPS,
  amountText, parseAmount, sliderToUsd, thinksLabel, usdToSlider,
} from './buyConfig';
import { localQuote } from './useQuote';
import type { LiveQuote } from './useQuote';

const CROSSED_MS = 5_000;

interface AmountStepProps {
  amountMicro: Micro;
  onAmount: (micro: Micro) => void;
  pace: Pace;
  onPace: (pace: Pace) => void;
  live: LiveQuote | null;
  models: ModelInfo[];
  feeBps: number;
}

export function AmountStep({ amountMicro, onAmount, pace, onPace, live, models, feeBps }: AmountStepProps) {
  const [text, setText] = useState(() => amountText(amountMicro));
  const [crossed, setCrossed] = useState<{ from: TierId; to: TierId } | null>(null);
  const prevTier = useRef<TierId | null>(live?.quote.tierId ?? null);

  // Keep the box in step with chips and the slider without fighting the buyer's own typing.
  useEffect(() => {
    const parsed = parseAmount(text);
    if (parsed !== amountMicro) setText(amountText(amountMicro));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountMicro]);

  // The moment the amount crosses a floor, say the trade out loud in the other direction too.
  const tierId = live?.quote.tierId ?? null;
  useEffect(() => {
    if (!tierId) return;
    const before = prevTier.current;
    prevTier.current = tierId;
    if (!before || before === tierId) return;
    setCrossed({ from: before, to: tierId });
    const id = setTimeout(() => setCrossed(null), CROSSED_MS);
    return () => clearTimeout(id);
  }, [tierId]);

  const commit = (raw: string) => {
    setText(raw);
    const parsed = parseAmount(raw);
    if (parsed !== null) onAmount(parsed);
  };

  const belowMin = amountMicro < MIN_PURCHASE_MICRO;
  const aboveMax = amountMicro > MAX_PURCHASE_MICRO;

  return (
    <>
      <div className="form-row">
        <div className="fl">
          <span>Amount</span>
          <span className="spacer" />
          <span>{fmtUsd(MIN_PURCHASE_MICRO)} minimum · {fmtUsd(MAX_PURCHASE_MICRO)} maximum</span>
        </div>
        <div className="buy-amount">
          <span className="ba-dollar">$</span>
          <input
            className="finput ba-input"
            value={text}
            inputMode="decimal"
            spellCheck={false}
            autoComplete="off"
            aria-label="Amount in US dollars"
            onChange={(e) => commit(e.target.value)}
            onBlur={() => setText(amountText(amountMicro))}
          />
          <div className="filter-row ba-chips">
            {AMOUNT_CHIPS.map((d) => {
              const micro = usd(d);
              return (
                <button
                  type="button"
                  key={d}
                  className={micro === amountMicro ? 'fbtn active' : 'fbtn'}
                  onClick={() => onAmount(micro)}
                >
                  ${d}
                </button>
              );
            })}
          </div>
        </div>
        <input
          className="buy-slider"
          type="range"
          min={0}
          max={SLIDER_STEPS}
          step={1}
          value={usdToSlider(amountMicro / 1_000_000)}
          aria-label="Amount slider"
          onChange={(e) => onAmount(usd(sliderToUsd(Number(e.target.value))))}
        />
        {belowMin && <div className="form-err">The minimum purchase is {fmtUsd(MIN_PURCHASE_MICRO)}.</div>}
        {aboveMax && <div className="form-err">The maximum purchase is {fmtUsd(MAX_PURCHASE_MICRO)}.</div>}
      </div>

      {live && (
        <>
          <TierBanner quote={live.quote} />
          <QuoteLedger quote={live.quote} models={models} diesOn={live.diesOn} />
          {live.optimistic && <div className="form-hint">Pricing…</div>}
          {live.error && <div className="alert warn section-gap">{live.error}</div>}
          {live.quote.gateRunwayDays !== null && live.quote.gateRunwayDays < MIN_PROJECTED_LIFE_DAYS && (
            <div className="alert warn section-gap">
              That projects to {live.quote.gateRunwayDays.toFixed(1)} days. A purchase must project at least{' '}
              {MIN_PROJECTED_LIFE_DAYS} days of life, so this amount will be refused.
            </div>
          )}
        </>
      )}

      <div className="form-row section-gap">
        <div className="fl"><span>Pace</span></div>
        <div className="seg pace-seg">
          {PACES.map((p) => (
            <button type="button" key={p} className={p === pace ? 'active' : undefined} onClick={() => onPace(p)}>
              {PACE_LABEL[p]}
            </button>
          ))}
        </div>
        <div className="form-hint">
          {PACE_NOTE[pace]}
          {live && (
            <>
              {' '}
              <b>{thinksLabel(live.quote.heartbeatMin, live.quote.stepsPerDay)}</b>
              {live.quote.runwayDays !== null && <> · projected life <b>{live.quote.runwayDays.toFixed(1)} days</b></>}
            </>
          )}
        </div>
      </div>

      {live && <BoundaryNotice quote={live.quote} models={models} feeBps={feeBps} pace={pace} />}
      {crossed && <CrossedNotice from={crossed.from} to={crossed.to} />}
    </>
  );
}

function TierBanner({ quote }: { quote: PurchaseQuote }) {
  const tier = tierById(quote.tierId);
  if (!tier) return null;
  return (
    <div className="buy-tier-banner">
      <div className="btb-head">
        <span className="btb-name">{tier.label}</span>
        <span className="chip">{TIER_CAPS[tier.id]}</span>
      </div>
      <div className="btb-blurb">{tier.blurb}</div>
    </div>
  );
}

/**
 * Runway is NOT monotone across a tier boundary: $24 buys a SPARK that lives ~165 days, $25 buys a
 * SCOUT that lives ~80. SPEC-V2 §2.5 forbids hiding that, so the invitation to upgrade states the
 * day count it costs, in the words "you are buying capability, not time".
 */
function BoundaryNotice({ quote, models, feeBps, pace }: { quote: PurchaseQuote; models: ModelInfo[]; feeBps: number; pace: Pace }) {
  const next = quote.nextTier;
  if (!next || !nearNextTier(quote.amountMicro)) return null;
  const nextTier = tierById(next.id);
  const at = localQuote(next.minMicro, feeBps, models, pace);
  if (!nextTier || !at) return null;

  return (
    <div className="alert section-gap">
      <span>
        <b>+{fmtUsd(next.addMicro)} more unlocks {nextTier.label}</b>: {TIER_CAPS[nextTier.id]}.{' '}
        {quote.runwayDays !== null && at.runwayDays !== null && (
          <>
            Projected life changes from {quote.runwayDays.toFixed(0)} to {at.runwayDays.toFixed(0)} days — you are buying
            capability, not time.
          </>
        )}
      </span>
    </div>
  );
}

/** Shown for five seconds after the amount crosses a floor, so the drop is never a surprise. */
function CrossedNotice({ from, to }: { from: TierId; to: TierId }) {
  const a = tierById(from);
  const b = tierById(to);
  if (!a || !b) return null;
  const up = b.minMicro > a.minMicro;
  return (
    <div className="alert section-gap">
      <span>
        {up ? (
          <>
            You crossed into <b>{b.label}</b>: {TIER_CAPS[b.id]}. It costs days — you are buying capability, not time.
          </>
        ) : (
          <>
            You dropped back to <b>{b.label}</b>: {TIER_CAPS[b.id]}. It buys days back and gives up capability.
          </>
        )}
      </span>
    </div>
  );
}

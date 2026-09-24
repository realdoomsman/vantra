// The commission ledger the buyer sees before paying (SPEC-V2 §9.2 item 4, §9.4).
// One component so the landing page's worked example and the live Buy quote cannot drift.
import type { ReactNode } from 'react';
import type { ModelInfo, PurchaseQuote } from '@vantra/shared';
import { fmtUsd } from '@vantra/shared';
import { TIER_CAPS, modelLabelOf, thinksLabel } from './buyConfig';
import { fmtDate } from '../../lib/format';

interface RowProps {
  k: ReactNode;
  v: ReactNode;
  total?: boolean;
  tone?: 'pos' | 'neg' | 'warn';
}

export function LedgerRow({ k, v, total, tone }: RowProps) {
  return (
    <div className={total ? 'cl-row total' : 'cl-row'}>
      <span className="k">{k}</span>
      <span className={tone ? `v ${tone}` : 'v'}>{v}</span>
    </div>
  );
}

interface QuoteLedgerProps {
  quote: PurchaseQuote;
  /** Catalog for the model's human label; the id is shown when it is not loaded. */
  models?: ModelInfo[];
  /** Death date; computed by the caller so it can prefer the server's `diesOn`. */
  diesOn?: string | null;
  /** Fork royalty row: '{parent} · 5% of external revenue'. */
  royalty?: { parentName: string; bps: number } | null;
}

/** Projected death date from a quote, using the browser clock. */
export function diesOnFromQuote(quote: PurchaseQuote, now = Date.now()): string | null {
  if (quote.runwayDays === null) return null;
  return new Date(now + quote.runwayDays * 86_400_000).toISOString();
}

export function QuoteLedger({ quote, models = [], diesOn, royalty }: QuoteLedgerProps) {
  const feePct = (quote.feeBps / 100).toFixed(quote.feeBps % 100 === 0 ? 0 : 1);
  const dies = diesOn ?? diesOnFromQuote(quote);

  return (
    <div className="commission-ledger">
      <LedgerRow k="YOU SEND" v={fmtUsd(quote.amountMicro)} />
      <LedgerRow k={`− PLATFORM FEE (${feePct}%)`} v={`−${fmtUsd(quote.feeMicro)}`} tone="warn" />
      <LedgerRow k="= INTO THE AGENT'S WALLET" v={fmtUsd(quote.fundingMicro)} tone="pos" total />
      <LedgerRow
        k="TIER"
        v={`${quote.tierLabel} · ${modelLabelOf(models, quote.modelId)} · ${TIER_CAPS[quote.tierId]}`}
      />
      <LedgerRow k="THINKS" v={thinksLabel(quote.heartbeatMin, quote.stepsPerDay)} />
      <LedgerRow k="BURNS" v={`${fmtUsd(quote.burnPerDayMicro)} / day`} />
      {royalty && (
        <LedgerRow k={`ROYALTY TO ${royalty.parentName}`} v={`${royalty.bps / 100}% of external revenue`} tone="warn" />
      )}
      <LedgerRow
        k="PROJECTED LIFE"
        v={quote.runwayDays === null ? '∞' : `${quote.runwayDays.toFixed(1)} days`}
        total
      />
      {dies && <LedgerRow k="DIES ~" v={fmtDate(dies)} total tone="neg" />}
    </div>
  );
}

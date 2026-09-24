// Live purchase quoting for the Buy page (SPEC-V2 §9.4).
//
// The browser computes the quote optimistically with `quoteFor` from @vantra/shared on every
// keystroke — the same pure function the API runs — and reconciles against `POST /api/quote`
// debounced 250 ms. The server value always wins, so a `HEARTBEAT_OVERRIDE_MIN` or a catalog the
// browser cannot see can never leave the UI lying about what the buyer will get.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentTier, Micro, ModelInfo, Pace, PurchaseQuote, QuoteResponse } from '@vantra/shared';
import { quoteFor, resolveTierModel, tierForMicro } from '@vantra/shared';
import { api } from '../../api/client';

const DEBOUNCE_MS = 250;

export interface LiveQuote {
  quote: PurchaseQuote;
  tier: AgentTier;
  /** ISO death date: the server's when it has answered, else derived from the local projection. */
  diesOn: string | null;
  /** True while the shown quote is the browser's optimistic guess. */
  optimistic: boolean;
  /** Set when the server refused the amount (BELOW_MINIMUM and friends). */
  error: string | null;
}

/** Local quote for any amount, used for the boundary comparison as well as the live one. */
export function localQuote(amountMicro: Micro, feeBps: number, models: ModelInfo[], pace: Pace): PurchaseQuote | null {
  const tier = tierForMicro(amountMicro);
  const model = resolveTierModel(tier, models);
  if (!model) return null;
  return quoteFor({ amountMicro, feeBps, model, pace, tier });
}

const key = (amountMicro: Micro, pace: Pace): string => `${amountMicro}:${pace}`;

export function useQuote(amountMicro: Micro, pace: Pace, models: ModelInfo[], feeBps: number): LiveQuote | null {
  const [server, setServer] = useState<{ key: string; quote: QuoteResponse } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const latest = useRef('');

  const wanted = key(amountMicro, pace);
  latest.current = wanted;

  useEffect(() => {
    let live = true;
    const id = setTimeout(() => {
      api
        .quote(amountMicro, pace)
        .then((q) => {
          if (!live || latest.current !== wanted) return;
          setServer({ key: wanted, quote: q });
          setError(null);
        })
        .catch((e: unknown) => {
          if (!live || latest.current !== wanted) return;
          // A refusal is information, not a failure: the optimistic quote stays on screen beside it.
          setError({ key: wanted, message: e instanceof Error ? e.message : 'Could not price that amount' });
        });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [amountMicro, pace, wanted]);

  const local = useMemo(() => localQuote(amountMicro, feeBps, models, pace), [amountMicro, feeBps, models, pace]);

  const fresh = server && server.key === wanted ? server.quote : null;
  const quote: PurchaseQuote | null = fresh ?? local;
  if (!quote) return null;

  const tier = tierForMicro(quote.amountMicro);
  const diesOn = fresh
    ? fresh.diesOn
    : quote.runwayDays === null
      ? null
      : new Date(Date.now() + quote.runwayDays * 86_400_000).toISOString();

  return {
    quote,
    tier,
    diesOn,
    optimistic: fresh === null,
    error: error && error.key === wanted ? error.message : null,
  };
}

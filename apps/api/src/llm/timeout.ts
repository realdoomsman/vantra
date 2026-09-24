// AMENDMENTS A6: every completion is bounded by `min(remainingStepMs, LLM_REQUEST_TIMEOUT_MS)`.
// The floor matters — a nearly-exhausted step would otherwise hand the SDK a zero or negative
// timeout, which it rejects outright instead of failing the way a slow call does.
import { LLM_REQUEST_TIMEOUT_MIN_MS, LLM_REQUEST_TIMEOUT_MS } from '@vantra/shared';

export function requestTimeoutMs(remainingMs: number | undefined): number {
  const wanted = remainingMs === undefined || !Number.isFinite(remainingMs) ? LLM_REQUEST_TIMEOUT_MS : remainingMs;
  return Math.max(LLM_REQUEST_TIMEOUT_MIN_MS, Math.min(wanted, LLM_REQUEST_TIMEOUT_MS));
}

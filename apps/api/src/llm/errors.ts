import type { ModelProvider } from '@vantra/shared';

export interface LlmCallErrorInit { status?: number; retryable: boolean; cause?: unknown }

// Provider failures normalised so the router can decide retries without knowing SDK error classes.
// `retryable` is true for 429, 5xx and network/timeout failures (SPEC §8.5, AMENDMENTS A6).
export class LlmCallError extends Error {
  readonly provider: ModelProvider;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(provider: ModelProvider, message: string, init: LlmCallErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'LlmCallError';
    this.provider = provider;
    this.status = init.status;
    this.retryable = init.retryable;
  }
}

export const isRetryableStatus = (status: number | undefined): boolean =>
  status === 429 || (status !== undefined && status >= 500);

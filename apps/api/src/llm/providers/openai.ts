import OpenAI from 'openai';
import type { LlmProvider } from '../../core/interfaces.js';
import { createChatProvider } from './chat.js';

export interface OpenAiProviderOpts { apiKey: string; client?: OpenAI }

// OpenAI Chat Completions; the router owns retries so the SDK's are off. Cost is priced from the
// catalog with the cached prompt subset at the cache-read rate (AMENDMENTS A5).
export function createOpenAiProvider(opts: OpenAiProviderOpts): LlmProvider {
  const client = opts.client ?? new OpenAI({ apiKey: opts.apiKey, maxRetries: 0 });
  return createChatProvider({ name: 'openai', client, costFromUsage: false });
}

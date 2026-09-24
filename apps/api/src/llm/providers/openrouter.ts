import OpenAI from 'openai';
import type { LlmProvider } from '../../core/interfaces.js';
import { createChatProvider } from './chat.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterProviderOpts { apiKey: string; client?: OpenAI }

// OpenRouter speaks the Chat Completions dialect. `usage: { include: true }` makes it report the
// billed USD cost, which is authoritative over catalog pricing (AMENDMENTS A5).
export function createOpenRouterProvider(opts: OpenRouterProviderOpts): LlmProvider {
  const client = opts.client ?? new OpenAI({
    apiKey: opts.apiKey,
    baseURL: OPENROUTER_BASE_URL,
    maxRetries: 0,
    defaultHeaders: { 'X-Title': 'VANTRA' },
  });
  return createChatProvider({ name: 'openrouter', client, costFromUsage: true });
}

import pino from 'pino';
import pretty from 'pino-pretty';

export type Logger = pino.Logger;

// Field names that must never reach a log line, whatever object they hang off.
const REDACT_PATHS = [
  'secret', 'secretKey', 'privateKey', 'fromSecret', 'payerSecret', 'signature',
  '*.secret', '*.secretKey', '*.privateKey', '*.fromSecret', '*.payerSecret',
  'req.headers.cookie', 'req.headers.authorization',
  'POOL_WALLET_SECRET', 'ESCROW_WALLET_SECRET', 'KEY_ENCRYPTION_KEY', 'SESSION_SECRET',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'BRAVE_API_KEY', 'TAVILY_API_KEY',
];

export function createLogger(opts: { level: string; pretty: boolean; name?: string }): Logger {
  const base = { level: opts.level, name: opts.name ?? 'vantra', redact: { paths: REDACT_PATHS, censor: '[redacted]' } };
  return opts.pretty ? pino(base, pretty({ colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname', sync: true })) : pino(base);
}

export const silentLogger: Logger = pino({ level: 'silent' });

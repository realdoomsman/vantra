// `pnpm demo`: forces the zero-cost stack, then boots normally. SPEC §8.18.
process.env.CHAIN_MODE = 'memory';
process.env.LLM_PROVIDER = 'mock';
process.env.SANDBOX_DRIVER = 'local';
process.env.DEMO = '1';
// In mock mode every tier resolves to a mock model, so a locally-bought SPARK would derive a 12-hour
// heartbeat and nothing visible would happen (SPEC-V2 §2.5, §5.9). An operator who sets this
// themselves still wins.
process.env.HEARTBEAT_OVERRIDE_MIN ??= '5';

await import('./index.js');

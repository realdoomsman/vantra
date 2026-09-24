import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve the shared package from source so tests never depend on a stale dist build.
const sharedSrc = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: { alias: { '@vantra/shared': sharedSrc } },
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    // The database harnesses serialise every test file on one Postgres advisory lock and are willing
    // to wait LOCK_TIMEOUT_MS (60s) for it. Running files in parallel therefore buys nothing — the
    // workers just queue on the lock — and on a slower Postgres link (a Windows host talking to a WSL
    // server, a CI container) the queue outlives the 60s and whole files fail with "timed out waiting
    // for the test database lock" without a single real assertion running. One file at a time makes the
    // lock uncontended; the hook timeout stays above LOCK_TIMEOUT_MS so the lock wait is still what decides.
    fileParallelism: false,
    hookTimeout: 90_000,
  },
});

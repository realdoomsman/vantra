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
    // to wait LOCK_TIMEOUT_MS (60s) for it. Vitest's default hook timeout is 10s, so under a loaded
    // suite the beforeEach was killed while it was still legitimately queueing for that lock — which
    // surfaced as "Hook timed out in 10000ms" on whole files at a time, not as a real failure. These
    // two numbers have to agree; this one is the larger so the lock wait is what actually decides.
    hookTimeout: 90_000,
  },
});

// Railway Infrastructure as Code for VANTRA (docs.railway.com/infrastructure-as-code). Railway
// does not read this file during a deploy; the Railway CLI evaluates it:
//
//   railway link                 # pick the project + environment once
//   railway config plan          # review: it must show NO variable or service deletes you did not intend
//   railway config apply
//
// It needs the `railway` package (TypeScript SDK) resolvable from here: `pnpm add -Dw railway`.
//
// The build and the start command are NOT here: they live in the root Dockerfile, which Railway builds
// on every deploy. This file owns what a Dockerfile cannot say — the Postgres the API talks to, the
// pre-deploy migration, the healthcheck, the teardown window and the non-secret mode switches. It is
// a named partial, so an apply only ever touches the resources declared below.
//
// The public address is vantra.fun, attached with `railway domain vantra.fun --port 8080` (and `www`);
// DNS at Porkbun: ALIAS @ and CNAME www at the targets Railway hands out, plus its `_railway-verify` TXTs.
// The Railway-provided domain keeps serving too, so logo URLs written into Pons under it never break.
//
// Secrets are never written here. Set them once with `railway variables --set NAME=value` (or the
// dashboard) BEFORE the first apply; `preserve()` keeps whatever value Railway already holds.
import { defineRailway, postgres, preserve, project, service } from 'railway/iac';

export const partial = 'vantra';

export default defineRailway(() => {
  const db = postgres('postgres');

  const api = service('vantra', {
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    // Applies apps/api/drizzle against DATABASE_URL in a throwaway container from the new image; a failure
    // stops the deploy before the new version serves anything.
    preDeploy: 'pnpm db:migrate',
    // Boot preflight probes the chain and the treasury before the server listens, so allow for a slow RPC.
    healthcheck: '/api/health',
    healthcheckTimeout: 180,
    deploy: {
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 5,
      // SIGTERM stops the scheduler, then waits for in-flight heartbeats (STEP_TIMEOUT_MS is 8 min) before
      // exiting; without a draining window Railway would SIGKILL them mid-step.
      drainingSeconds: 540,
    },
    // One port everywhere: the image listens on PORT (8080, also its default) and the domain routes there.
    env: {
      PORT: '8080',
      DATABASE_URL: db.env.DATABASE_URL,
      NODE_ENV: 'production',
      PUBLIC_URL: 'https://vantra.fun',
      API_URL: 'https://vantra.fun',
      DEMO: '0',
      CHAIN_MODE: 'robinhood',
      RHC_NETWORK: 'mainnet',
      ALLOW_MAINNET: '1',
      LLM_PROVIDER: 'router',
      // Railway cannot run a Docker daemon: no agent code execution, sandbox tools withheld (sandbox/none.ts).
      SANDBOX_DRIVER: 'none',
      SEARCH_PROVIDER: 'tavily',
      RHC_RPC_URL: preserve(),
      SESSION_SECRET: preserve(),
      KEY_ENCRYPTION_KEY: preserve(),
      TREASURY_WALLET_SECRET: preserve(),
      ESCROW_WALLET_SECRET: preserve(),
      FOUNDER_FEE_WALLET: preserve(),
      PROTOCOL_FEE_WALLET: preserve(),
      ANTHROPIC_API_KEY: preserve(),
      OPENAI_API_KEY: preserve(),
      OPENROUTER_API_KEY: preserve(),
      TAVILY_API_KEY: preserve(),
    },
  });

  return project('vantra', { resources: [api, db] });
});

// Composition root: builds every dependency from Config in dependency order and owns start/stop.
import { eq } from 'drizzle-orm';
import type { Address, TypedDataDefinition } from 'viem';
import { createChain } from '../chain/index.js';
import { accountFromSecret } from '../chain/keys.js';
import { withAgentSecret } from '../chain/keystore.js';
import type { EvmSignerResolver } from '../llm/providers/x402.js';
import type { Config } from '../config.js';
import { assertSchema, createDb } from '../db/client.js';
import { agentKeys } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { toChecksum } from '../lib/evm.js';
import { createServices, hostingLedgerHook, hostingRefund } from '../economy/index.js';
import { restoreMemoryLaunches } from '../economy/launch.js';
import type { HostingDeps } from '../hosting/index.js';
import { createServer } from '../http/index.js';
import { FastClock, systemClock } from '../lib/clock.js';
import type { Logger } from '../lib/log.js';
import { createLlmRouter } from '../llm/index.js';
import { createPayments } from '../payments/index.js';
import { createRuntime } from '../runtime/index.js';
import { createSandbox } from '../sandbox/index.js';
import { createSearch } from '../search/index.js';
import { runDemo } from '../sim/index.js';
import { createToolRegistry } from '../tools/index.js';
import { createBus } from './bus.js';
import type { Clock, CoreDeps, Deps, HttpServer } from './interfaces.js';
import { toolPorts } from './ports.js';
import { assertReady, type PreflightProbes } from './preflight.js';
import { realProbes } from './probes.js';

export interface Container {
  deps: Deps;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ContainerOpts {
  /** Test seam for the boot preflight; production passes the real daemon and RPC probes. */
  probes?: PreflightProbes;
}

export async function createContainer(config: Config, log: Logger, opts: ContainerOpts = {}): Promise<Container> {
  const dbHandle = createDb(config.databaseUrl);
  const clock: Clock = config.demo.enabled ? new FastClock() : systemClock;
  // x402 inference (LLM_PROVIDER=x402): each agent pays the gateway from its OWN wallet, so the LLM
  // router needs a signer bound to the agent. What it gets is deliberately NOT a resolved viem
  // account: `privateKeyToAccount` keeps the plaintext key in an immutable JS string that nothing can
  // zero, and holding one for the length of an inference call would leave a real wallet's key sitting
  // in the heap. Instead the address comes from `agent_keys.pubkey` — the address of the very key
  // that will sign, written when the key was created — and each signature re-enters
  // `withAgentSecret`, derives an account inside that scope, signs, and lets both the account and the
  // zeroed secret buffer go out of scope. One decrypt per signature, nothing cached, nothing logged.
  const resolveSigner: EvmSignerResolver | undefined = config.llm.provider === 'x402'
    ? async (agentId) => {
      const [row] = await dbHandle.db.select({ pubkey: agentKeys.pubkey }).from(agentKeys)
        .where(eq(agentKeys.agentId, agentId)).limit(1);
      if (!row) throw notFound(`Key for agent ${agentId}`);
      return {
        // `toChecksum` throws on anything that is not an address, so the EIP-55 narrowing is earned.
        address: toChecksum(row.pubkey) as Address,
        signTypedData: (params) => withAgentSecret(dbHandle.db, config.keyEncryptionKey, agentId, async (secret) => {
          // Two libraries declare the same EIP-712 payload independently: x402's is record-shaped,
          // viem's is `TypedDataDefinition`. One cast at the boundary, nowhere else.
          const viemParams = params as unknown as TypedDataDefinition;
          return accountFromSecret(secret).signTypedData(viemParams);
        }),
      };
    }
    : undefined;
  const { chain, launchpad } = await createChain(config, log.child({ mod: 'chain' }), { clock });
  const core: CoreDeps = {
    config,
    db: dbHandle.db,
    clock,
    bus: createBus(log),
    log,
    chain,
    launchpad,
    sandbox: createSandbox(config, log.child({ mod: 'sandbox' })),
    search: createSearch(config, log.child({ mod: 'search' })),
    llm: createLlmRouter(config, log.child({ mod: 'llm' }), resolveSigner),
  };
  // `deps` is one object the late members are attached to; the ports below read it at call time,
  // so they see `services`/`runtime` once they exist.
  const deps: Deps = { ...core, tools: null as never };
  deps.tools = createToolRegistry(deps, toolPorts(deps));
  deps.services = createServices(deps);
  deps.runtime = createRuntime(deps);
  // Payments read `services` lazily at call time (fulfilment spawns through it), so the order here
  // only has to put the object in place before anything is started.
  deps.payments = createPayments(deps);
  // POST /svc charges the seller's compute and refunds a buyer whose handler run failed.
  (deps as HostingDeps).hostingLedger = hostingLedgerHook(deps);
  (deps as HostingDeps).hostingRefund = hostingRefund(deps);
  let http: HttpServer | null = null;

  return {
    deps,
    async start() {
      await assertSchema(deps.db);
      // Before anything listens or spends: refuse every configuration that would look real and not be.
      // The docker and chain probes actually call out; nothing here trusts a flag.
      await assertReady({
        config,
        log: log.child({ mod: 'preflight' }),
        probes: opts.probes ?? realProbes(config, deps.chain),
        models: deps.llm.models(),
      });
      await deps.llm.refreshPricing();
      // Memory mode keeps launch records, escrow and coin prices in-process; re-register every listed
      // coin before anything can confirm, trade or burn against it. A no-op on a real chain.
      await restoreMemoryLaunches(deps);
      http = await createServer(deps);
      await http.listen();
      if (config.demo.enabled) {
        log.info({ agents: config.demo.agents, days: config.demo.days, seed: config.demo.seed }, 'seeding demo colony');
        await runDemo(deps);
      }
      await deps.runtime!.start();
      await deps.payments!.start();
    },
    async stop() {
      await deps.payments?.stop();
      await deps.runtime?.stop();
      await http?.close();
      await dbHandle.close();
    },
  };
}

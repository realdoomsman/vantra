// One TreasuryService per container, built from the chain module's treasury accounting (SPEC-V2 §5.7,
// renamed from economy/pool.ts). Everything that touches the treasury — purchase sweeps, agent funding,
// gas top-ups, withdraw fees, the 60s sync — goes through this single instance so the `pool` row,
// `pool_txs` and the WS 'treasury' message stay consistent.
import { createTreasuryService, type TreasuryService } from '../chain/pool.js';
import { createTreasuryStore } from '../chain/poolStore.js';
import { getProtocolWallets } from '../chain/wallets.js';
import type { CoreDeps } from '../core/interfaces.js';

export type TreasuryDeps = Pick<CoreDeps, 'config' | 'db' | 'chain' | 'bus' | 'clock' | 'log'>;

const cache = new WeakMap<object, TreasuryService>();

export function treasuryService(deps: TreasuryDeps): TreasuryService {
  const key = deps.db as unknown as object;
  const cached = cache.get(key);
  if (cached) return cached;
  const protocol = getProtocolWallets(deps.config);
  const service = createTreasuryService({
    config: deps.config,
    chain: deps.chain,
    bus: deps.bus,
    clock: deps.clock,
    log: deps.log.child({ mod: 'treasury' }),
    store: createTreasuryStore(deps.db, deps.clock),
    wallet: protocol.treasury,
    founderWallet: protocol.founderFee,
  });
  cache.set(key, service);
  return service;
}

export type { TreasuryService };

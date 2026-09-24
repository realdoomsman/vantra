import type { Config } from '../config.js';
import type { SandboxDriver } from '../core/interfaces.js';
import type { Logger } from '../lib/log.js';
import { createDockerSandbox } from './docker.js';
import { egressFirewallRules } from './egress.js';
import { createLocalSandbox } from './local.js';
import { createNoSandbox } from './none.js';

// SANDBOX_DRIVER=docker (per-agent container) | local (child_process, dev only) | none (no sandbox;
// the registry withholds every tool that needs one). SPEC §8.17.
export function createSandbox(config: Config, log: Logger): SandboxDriver {
  if (config.sandbox.driver === 'none') return createNoSandbox();
  if (config.sandbox.driver === 'local') {
    return createLocalSandbox({ dataDir: config.dataDir, isProduction: config.isProduction, log });
  }
  // Half of the egress boundary lives in the host firewall (sandbox/egress.ts). Production cannot boot
  // without confirming it; elsewhere, say plainly that `bash` can currently reach the private network.
  if (!config.sandbox.egressFiltered) {
    log.warn(
      { network: config.sandbox.network, rules: egressFirewallRules(config.sandbox.network) },
      'SANDBOX_EGRESS_FILTERED is off: agent bash can reach private addresses that fetch_url refuses',
    );
  }
  return createDockerSandbox({ image: config.sandbox.image, network: config.sandbox.network, log });
}

export { SandboxLimitError, SandboxPathError, SandboxUnavailableError, normalizeRelPath, shellQuote } from './common.js';
export {
  AGENT_NETWORK_DEFAULT, BLOCKED_EGRESS_CIDRS, BLOCKED_EGRESS_CIDRS_V6, BLOCKED_METADATA_HOSTS,
  egressFirewallRules, metadataExtraHosts, networkCreateOptions,
} from './egress.js';

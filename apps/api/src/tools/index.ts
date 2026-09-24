// Tool registry: one canonical JSON schema per tool (Anthropic style, additionalProperties:false),
// validated execution that never throws, per-tool cost accounting and secret-free input summaries.
// SPEC §8.9; AMENDMENTS A7, A9, B12, B16, B19, C27, C28.
import type { CoreDeps, ToolRegistry } from '../core/interfaces.js';
import { bountyTools } from './bounties.js';
import { deployTools } from './deploy.js';
import { fileTools } from './files.js';
import { metaTools } from './meta.js';
import { portResolver, type ToolPorts } from './ports.js';
import { buildRegistry } from './registry.js';
import { serviceTools } from './services.js';
import { tradeTools } from './trade.js';
import { walletTools } from './wallet.js';
import { webTools } from './web.js';

// `ports` carries the four capabilities that live outside this module (agent wallet transfers, the
// escrow wallet, the /svc handler runner and the hosting deploy helper). They are optional so the
// registry can be built before them; a tool that needs an unwired port returns an is_error result.
export function createToolRegistry(deps: CoreDeps, ports?: ToolPorts): ToolRegistry {
  const port = portResolver(ports);
  const log = deps.log.child({ mod: 'tools' });
  return buildRegistry([
    ...webTools(deps),
    ...fileTools(deps),
    ...deployTools(deps, port),
    ...serviceTools(deps, port),
    ...bountyTools(deps, port),
    ...tradeTools(deps, port),
    ...walletTools(deps),
    ...metaTools(deps),
  ], deps.bus, log, deps.config.sandbox.driver);
}

export { INPUT_SUMMARY_MAX, redactSecrets } from './registry.js';
export { toInputSchema } from './spec.js';
export type { DeployPort, EscrowPort, InternalServiceInvoker, PaymentsPort, ServiceInvocation, ToolPorts } from './ports.js';
export { BOUNTY_CLAIM_WINDOW_MS, BOUNTY_MAX_REJECTIONS, submitDeadline } from './bounties.js';

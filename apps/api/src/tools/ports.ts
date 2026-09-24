// Ports the tool registry needs from modules built elsewhere (agent/escrow wallets, the hosting deploy
// helper, the /svc handler runner). The composition root wires them; tests pass fakes.
//
// NOTE on ledger rows: the registry deliberately does NOT write to `ledger`. Money a tool costs the agent
// is returned as `ToolResult.costMicro` + `ledgerKind` and posted by the step loop (core/interfaces.ts:
// "call_service → 'payment'"), so economy/ledger.ts stays the single writer of treasury columns. These
// ports only move real USDC and run sandboxed work.
import type { Micro } from '@vantra/shared';

// Sends USDC out of an agent's custodied wallet (economy/wallets.ts:transferFromAgent — the key is
// decrypted there for the duration of the call and never reaches this module). Returns the tx signature.
export interface PaymentsPort {
  transferFromAgent(agentId: string, toPubkey: string, amountMicro: Micro, memo: string): Promise<string>;
}

// Protocol-custodied escrow wallet (config ESCROW_WALLET_SECRET; memory chain: a generated keypair).
export interface EscrowPort {
  readonly pubkey: string;
  payout(toPubkey: string, amountMicro: Micro, memo: string): Promise<string>;   // tx signature
}

export interface ServiceInvocation {
  callId: number;
  status: 'ok' | 'error' | 'timeout';
  output: unknown;
  cpuMs: number;
}

// Runs a service handler in the SELLER's sandbox (`node <handlerPath>` with the JSON input on stdin, 30s
// cap), records the `service_calls` row and charges the seller its compute floor max(500, cpuMs × 0.1)
// (AMENDMENTS B19). It does NOT take payment: the caller owns the buyer side.
export interface InternalServiceInvoker {
  invoke(serviceId: string, agentId: string, input: unknown): Promise<ServiceInvocation>;
}

// Exports `dir` from the agent's sandbox into the static hosting root for `slug`, keeping only whitelisted
// static files (SPEC §8.9), ≤ 20MB, atomically replacing the previous content, and upserting the
// `deployments` row. Throws with an agent-readable message when the directory is missing, has no
// index.html, holds files that cannot be hosted, exceeds the size cap, or when another agent owns the slug.
export interface DeployPort {
  deploySite(agentId: string, dir: string, slug: string): Promise<{ slug: string; url: string; bytes: number; files: number }>;
}

// Executes an agent's trade: enforces the guardrails, swaps from the agent's own wallet, books the
// ledger + position + P&L. Implemented by economy/trading.ts; wired by the composition root.
export interface TradingPort {
  execute(input: { agentId: string; action: 'buy' | 'sell'; token: string; amountUsd: number | null }): Promise<{ ok: boolean; message: string }>;
}

export interface ToolPorts {
  payments: PaymentsPort;
  escrow: EscrowPort;
  invoker: InternalServiceInvoker;
  deploy: DeployPort;
  trading: TradingPort;
}

export type PortResolver = <K extends keyof ToolPorts>(name: K) => ToolPorts[K];

// Ports are resolved lazily so the registry can be built before them; an unwired port surfaces as an
// is_error tool result (registry.execute catches) rather than crashing a step.
export function portResolver(ports: ToolPorts | undefined): PortResolver {
  return (name) => {
    if (!ports) throw new Error(`the ${name} port is not wired on this deployment, so this tool is unavailable`);
    return ports[name];
  };
}

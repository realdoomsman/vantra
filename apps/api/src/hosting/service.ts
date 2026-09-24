// Service execution: verifies the buyer, runs the seller's handler in its sandbox, records the call and
// charges the seller's compute. SPEC §8.9 create_service/call_service, §8.15 POST /svc; AMENDMENTS B19.
import { eq, sql } from 'drizzle-orm';
import { TOOL_COST_MICRO, type LedgerKind, type Micro } from '@vantra/shared';
import { invalidTx, verifyUsdcTransfer } from '../chain/verify.js';
import type { ChainAdapter, Clock, SandboxDriver, SandboxExecResult } from '../core/interfaces.js';
import type { Db } from '../db/client.js';
import { type AgentRow, type ServiceRow, agents, serviceCalls, services } from '../db/schema.js';
import { ApiError, badRequest, conflict, notFound, uniqueViolation } from '../lib/errors.js';
import type { Logger } from '../lib/log.js';
import { shellQuote } from '../sandbox/common.js';

export const SERVICE_INPUT_MAX_BYTES = 64 * 1024;
export const SERVICE_OUTPUT_MAX_BYTES = 256 * 1024;
export const SERVICE_TIMEOUT_MS = 30_000;
// A payment signature is a bearer token, and inbound transfers to an agent wallet are public on chain.
// Without a freshness bound, anyone could lift the seed transfer's signature (or an earlier customer's)
// out of the explorer and spend it as a coupon; `service_calls.payment_tx` only stops the SECOND use.
export const PAYMENT_MAX_AGE_MS = 15 * 60_000;
const MIN_TIMEOUT_MS = 1_000;
const DIAG_TAIL_CHARS = 2_000;

// Wired by the integration agent to economy/ledger.ts:post — the only writer of treasury columns.
export type LedgerHook = (agentId: string, kind: LedgerKind, amountMicro: Micro, memo: string, meta: Record<string, unknown>) => Promise<void>;

// Sends USDC back out of the SELLER's wallet when its handler did not deliver (economy/ports.ts).
export type PaymentRefund = (sellerAgentId: string, toWallet: string, amountMicro: Micro, memo: string) => Promise<string>;

export type ServiceCaller =
  // POST /svc with x-payment-tx (no session: `wallet` is null) or /api/market/services/:id/call, where
  // the signed-in wallet is known and the transfer must have come FROM it.
  | { type: 'user'; paymentTxSig: string; wallet?: string | null }
  | { type: 'agent'; agentId: string };        // call_service tool: price already ledgered as `payment`

export type ServiceCallStatus = 'ok' | 'error' | 'timeout';
export interface ServiceCallOutcome {
  callId: number;
  status: ServiceCallStatus;
  output: unknown;
  cpuMs: number;
  priceMicro: Micro;
  sellerCostMicro: Micro;
  buyerId: string;             // wallet (user) or agent id
  service: ServiceRow;
}

export type SellerRow = Pick<AgentRow, 'id' | 'name' | 'status' | 'walletPubkey'>;
export type NewServiceCall = typeof serviceCalls.$inferInsert;
export interface ServiceStore {
  get(serviceId: string): Promise<{ service: ServiceRow; agent: SellerRow } | null>;
  paymentUsed(txSig: string): Promise<boolean>;
  record(call: NewServiceCall): Promise<number>;    // inserts service_calls and bumps services.calls/revenue
}

export interface ServiceRunnerDeps {
  sandbox: SandboxDriver; chain: ChainAdapter; clock: Clock; log: Logger;
  // Fired after the call is recorded so the runtime can pull the seller's next heartbeat forward
  // (SPEC-V2 §7.4). Synchronous and fire-and-forget: a wake must never fail a paid call.
  onSold?: (sellerAgentId: string, keptPayment: boolean) => void;
}
export interface ServiceRunner { call(serviceId: string, caller: ServiceCaller, input: unknown): Promise<ServiceCallOutcome> }

// Runs a handler without taking payment or writing service_calls — the caller owns those. The shape matches
// tools/ports.ts:InternalServiceInvoker so the call_service tool can use it directly.
export interface ServiceInvocation { output: unknown; status: ServiceCallStatus; cpuMs: number }
export interface ServiceInvoker { invoke(service: ServiceRow, input: unknown, opts?: { remainingMs?: number }): Promise<ServiceInvocation> }

// Seller's compute charge per handler run: max(service_call_min, cpuMs × bash_per_cpu_sec / 1000).
export function sellerComputeMicro(cpuMs: number): Micro {
  return Math.max(TOOL_COST_MICRO.service_call_min!, Math.ceil((cpuMs * TOOL_COST_MICRO.bash_per_cpu_sec!) / 1000));
}

export function createServiceRunner(
  deps: ServiceRunnerDeps, store: ServiceStore, ledger: LedgerHook | null, refund: PaymentRefund | null = null,
): ServiceRunner {
  return {
    async call(serviceId, caller, input) {
      const found = await store.get(serviceId);
      if (!found) throw notFound('Service');
      const { service, agent } = found;
      if (service.status !== 'active') throw conflict('NOT_ELIGIBLE', 'service is paused');
      if (agent.status === 'dead' || agent.status === 'spawning') throw conflict('NOT_ELIGIBLE', `seller agent is ${agent.status}`);

      const inputJson = encodeInput(input);
      const buyer = await resolveBuyer(deps.chain, store, caller, service, agent, deps.clock.now());
      const exec = await runHandler(deps.sandbox, agent.id, service.handlerPath, inputJson, SERVICE_TIMEOUT_MS);
      const { status, output } = interpret(exec, SERVICE_TIMEOUT_MS);
      const sellerCostMicro = sellerComputeMicro(exec.cpuMs);
      // A human buyer pays BEFORE the handler runs, so a handler that errored or timed out has taken
      // money for nothing. The agent path never charges on failure (core/ports.ts records price 0);
      // this is the same rule for the path that already holds the USDC.
      const keepsPayment = status === 'ok';

      let callId: number;
      try {
        callId = await store.record({
          serviceId: service.id, buyerType: buyer.type, buyerId: buyer.id,
          priceMicro: keepsPayment ? service.priceMicro : 0,
          status, request: input === undefined ? null : input, response: output, cpuMs: exec.cpuMs,
          paymentTx: buyer.paymentTx, ts: deps.clock.now(),
        });
      } catch (e) {
        if (uniqueViolation(e) !== null) throw conflict('INVALID_TX', 'payment tx already used');
        throw e;
      }

      deps.onSold?.(agent.id, keepsPayment);

      if (!keepsPayment && buyer.type === 'user' && service.priceMicro > 0) {
        await refundBuyer(deps.log, refund, ledger, {
          sellerAgentId: agent.id, toWallet: buyer.id, amountMicro: service.priceMicro,
          serviceId: service.id, serviceName: service.name, callId, status,
        });
      }

      await chargeSellerCompute(deps.log, ledger, agent.id, sellerCostMicro, `service ${service.name} call #${callId}`, {
        serviceId: service.id, callId, cpuMs: exec.cpuMs, buyerType: buyer.type, buyerId: buyer.id, status,
      });
      deps.log.info({ serviceId: service.id, callId, status, cpuMs: exec.cpuMs, buyerType: buyer.type }, 'service call');
      return { callId, status, output, cpuMs: exec.cpuMs, priceMicro: service.priceMicro, sellerCostMicro, buyerId: buyer.id, service };
    },
  };
}

interface RefundInput {
  sellerAgentId: string; toWallet: string; amountMicro: Micro;
  serviceId: string; serviceName: string; callId: number; status: ServiceCallStatus;
}

// The refund is best-effort on purpose: the buyer already has the answer (an error message) and the
// call is recorded, so a chain failure must not turn into a 500 that hides both. It is logged loudly
// and the ledger row makes the outstanding obligation visible.
async function refundBuyer(log: Logger, refund: PaymentRefund | null, ledger: LedgerHook | null, r: RefundInput): Promise<void> {
  if (!refund) {
    log.error({ ...r }, 'no refund port wired: buyer was charged for a failed service call');
    return;
  }
  let sig: string;
  try {
    sig = await refund(r.sellerAgentId, r.toWallet, r.amountMicro, `refund for ${r.serviceName} call #${r.callId}`);
  } catch (e) {
    log.error({ err: e, ...r }, 'refund transfer failed; the buyer paid for a failed service call');
    return;
  }
  if (!ledger) return;
  try {
    // `payment` is money leaving the agent, which is what a refund out is; the buyer's inbound
    // transfer is booked separately by the deposit scan, so the two net to zero.
    await ledger(r.sellerAgentId, 'payment', -r.amountMicro, `refund: ${r.serviceName} call #${r.callId} ${r.status}`, {
      serviceId: r.serviceId, callId: r.callId, refundTo: r.toWallet, txSig: sig, status: r.status,
    });
  } catch (e) {
    log.error({ err: e, ...r }, 'failed to ledger a service refund');
  }
}

// In-process handler execution for the call_service tool: the tool has already taken payment from the buyer
// and writes the service_calls row itself, so this only runs the handler and bills the seller's compute.
export function createServiceInvoker(deps: { sandbox: SandboxDriver; log: Logger }, ledger: LedgerHook | null): ServiceInvoker {
  return {
    async invoke(service, input, opts) {
      const inputJson = encodeInput(input);
      const timeoutMs = Math.max(MIN_TIMEOUT_MS, Math.min(SERVICE_TIMEOUT_MS, opts?.remainingMs ?? SERVICE_TIMEOUT_MS));
      const exec = await runHandler(deps.sandbox, service.agentId, service.handlerPath, inputJson, timeoutMs);
      const { status, output } = interpret(exec, timeoutMs);
      await chargeSellerCompute(deps.log, ledger, service.agentId, sellerComputeMicro(exec.cpuMs), `service ${service.name} handler run`, {
        serviceId: service.id, cpuMs: exec.cpuMs, status,
      });
      return { output, status, cpuMs: exec.cpuMs };
    },
  };
}

function encodeInput(input: unknown): string {
  const json = JSON.stringify(input === undefined ? null : input) ?? 'null';
  if (Buffer.byteLength(json) > SERVICE_INPUT_MAX_BYTES) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `input exceeds ${SERVICE_INPUT_MAX_BYTES} bytes`);
  }
  return json;
}

// A failed ledger post must not lose the handler's answer: the call is already recorded, so log and carry on.
async function chargeSellerCompute(
  log: Logger, ledger: LedgerHook | null, agentId: string, amountMicro: Micro, memo: string, meta: Record<string, unknown>,
): Promise<void> {
  if (!ledger) {
    log.warn({ agentId, amountMicro, memo }, 'no ledger hook wired: seller compute not charged');
    return;
  }
  try {
    await ledger(agentId, 'compute', -amountMicro, memo, meta);
  } catch (e) {
    log.error({ err: e, agentId, memo }, 'failed to ledger seller compute cost');
  }
}

interface ResolvedBuyer { type: 'user' | 'agent'; id: string; paymentTx: string | null }

async function resolveBuyer(
  chain: ChainAdapter, store: ServiceStore, caller: ServiceCaller, service: ServiceRow, seller: SellerRow, now: Date,
): Promise<ResolvedBuyer> {
  if (caller.type === 'agent') {
    if (caller.agentId === seller.id) throw badRequest('an agent cannot call its own service');
    return { type: 'agent', id: caller.agentId, paymentTx: null };
  }
  const sig = caller.paymentTxSig.trim();
  if (!sig) throw new ApiError(402, 'PAYMENT_REQUIRED', `payment required: send ${service.priceMicro} micro-USDC to ${seller.walletPubkey} and pass the tx signature`);
  if (await store.paymentUsed(sig)) throw conflict('INVALID_TX', 'payment tx already used');
  const transfer = await verifyUsdcTransfer(chain, sig, {
    to: seller.walletPubkey, minAmount: service.priceMicro, what: 'service payment',
    // The signed-in caller must be the payer; an anonymous /svc call can only prove the destination.
    ...(caller.wallet ? { from: caller.wallet } : {}),
  });
  // Exactly the listed price, not "at least": `>=` turns every larger historical inbound transfer to
  // this wallet — the $10 seed included — into a valid coupon for a cheap service.
  if (transfer.amount !== service.priceMicro) {
    throw invalidTx(`The service payment moved ${transfer.amount} micro-USDC, the price is ${service.priceMicro}`);
  }
  const ageMs = now.getTime() - transfer.ts.getTime();
  if (ageMs > PAYMENT_MAX_AGE_MS) {
    throw invalidTx(`That payment is ${Math.round(ageMs / 60_000)} minutes old; pay again (payments expire after ${PAYMENT_MAX_AGE_MS / 60_000} minutes)`);
  }
  return { type: 'user', id: transfer.from, paymentTx: transfer.sig };
}

async function runHandler(sandbox: SandboxDriver, agentId: string, handlerPath: string, inputJson: string, timeoutMs: number): Promise<SandboxExecResult> {
  try {
    return await sandbox.exec(agentId, `node ${shellQuote(handlerPath)}`, { stdin: inputJson, timeoutMs });
  } catch (e) {
    return { stdout: '', stderr: e instanceof Error ? e.message : String(e), exitCode: -1, cpuMs: 0, timedOut: false };
  }
}

function interpret(exec: SandboxExecResult, timeoutMs: number): { status: ServiceCallStatus; output: unknown } {
  const stderr = exec.stderr.slice(-DIAG_TAIL_CHARS);
  if (exec.timedOut) return { status: 'timeout', output: { error: `handler timed out after ${Math.round(timeoutMs / 1000)}s`, stderr } };
  if (exec.exitCode !== 0) return { status: 'error', output: { error: `handler exited with code ${exec.exitCode}`, stderr } };
  if (Buffer.byteLength(exec.stdout) > SERVICE_OUTPUT_MAX_BYTES) return { status: 'error', output: { error: `handler output exceeds ${SERVICE_OUTPUT_MAX_BYTES} bytes` } };
  try {
    return { status: 'ok', output: JSON.parse(exec.stdout.trim() || 'null') as unknown };
  } catch {
    return { status: 'error', output: { error: 'handler output is not valid JSON', stdout: exec.stdout.slice(0, DIAG_TAIL_CHARS), stderr } };
  }
}

export function createServiceStore(db: Db): ServiceStore {
  return {
    async get(serviceId) {
      const [row] = await db
        .select({ service: services, agent: { id: agents.id, name: agents.name, status: agents.status, walletPubkey: agents.walletPubkey } })
        .from(services).innerJoin(agents, eq(agents.id, services.agentId))
        .where(eq(services.id, serviceId)).limit(1);
      return row ?? null;
    },
    async paymentUsed(txSig) {
      const [row] = await db.select({ id: serviceCalls.id }).from(serviceCalls).where(eq(serviceCalls.paymentTx, txSig)).limit(1);
      return row !== undefined;
    },
    async record(call) {
      return db.transaction(async (tx) => {
        const [inserted] = await tx.insert(serviceCalls).values(call).returning({ id: serviceCalls.id });
        await tx.update(services)
          .set({ calls: sql`${services.calls} + 1`, revenueMicro: sql`${services.revenueMicro} + ${call.priceMicro}` })
          .where(eq(services.id, call.serviceId));
        return inserted!.id;
      });
    },
  };
}

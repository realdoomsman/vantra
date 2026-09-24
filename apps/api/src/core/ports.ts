// Composition-root adapters for tools/ports.ts. The registry is built before economy/ and hosting/,
// so the four capabilities it needs are supplied here, where every module already exists.
import { escrowPort, hostingLedgerHook, paymentsPort } from '../economy/ports.js';
import { createServiceStore, deployPort, serviceInvoker } from '../hosting/index.js';
import { tradingPort } from '../economy/trading.js';
import { notFound } from '../lib/errors.js';
import type { InternalServiceInvoker, ToolPorts } from '../tools/index.js';
import type { Deps } from './interfaces.js';

export function toolPorts(deps: Deps): ToolPorts {
  return {
    payments: paymentsPort(deps),
    escrow: escrowPort(deps),
    deploy: deployPort(deps),
    invoker: internalInvoker(deps),
    trading: tradingPort(deps),
  };
}

// call_service: hosting runs the seller's handler and bills its compute; the `service_calls` row is
// written here because the tool pays the seller only after a successful run (B19). A handler that
// failed is still recorded — with price 0, since the buyer was never charged for it.
function internalInvoker(deps: Deps): InternalServiceInvoker {
  const invoker = serviceInvoker(deps, { ledger: hostingLedgerHook(deps) });
  const store = createServiceStore(deps.db);
  return {
    async invoke(serviceId, agentId, input) {
      const found = await store.get(serviceId);
      if (!found) throw notFound('Service');
      const run = await invoker.invoke(found.service, input);
      const callId = await store.record({
        serviceId, buyerType: 'agent', buyerId: agentId,
        priceMicro: run.status === 'ok' ? found.service.priceMicro : 0,
        status: run.status, request: input === undefined ? null : input, response: run.output,
        cpuMs: run.cpuMs, ts: deps.clock.now(),
      });
      return { callId, status: run.status, output: run.output, cpuMs: run.cpuMs };
    },
  };
}

import type { Deps, Payments, Services } from '../core/interfaces.js';
import { ApiError } from '../lib/errors.js';

// `deps.services` and `deps.payments` are attached to the container after the HTTP app's
// dependencies exist, so routes read them at call time rather than capturing them at registration.
export function servicesOf(deps: Deps): Services {
  if (!deps.services) throw new ApiError(503, 'UNAVAILABLE', 'Services are not ready');
  return deps.services;
}

export function paymentsOf(deps: Deps): Payments {
  if (!deps.payments) throw new ApiError(503, 'UNAVAILABLE', 'Payments are not ready');
  return deps.payments;
}

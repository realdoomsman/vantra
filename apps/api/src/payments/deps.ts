// What the payments module needs from the container. `services` is attached to the same `Deps` object
// after construction, so it is read lazily at call time and never destructured in a factory body.
import type { CoreDeps, Payments, Services } from '../core/interfaces.js';

export type PaymentsDeps = CoreDeps & { services?: Services; payments?: Payments };

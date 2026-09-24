// Serialises treasury payouts against treasury syncs so a balance read never interleaves with a transfer,
// and — on EVM — serialises every send from one address so two concurrent sends can never take the same
// nonce. The second guarantee is not optional: the treasury signs for many agents at once, and a
// duplicated nonce means one of the two transactions is silently dropped by the node.
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

// One mutex per sending address, created on demand and dropped again once nothing is queued on it —
// deposit addresses are minted per purchase, so a map that only grew would leak for the life of the
// process.
interface AddressLock { mutex: Mutex; queued: number }
const addressLocks = new Map<string, AddressLock>();

export function withAddressLock<T>(address: string, fn: () => Promise<T>): Promise<T> {
  const key = address.toLowerCase();          // addresses are stored EIP-55; the lock must not care
  let lock = addressLocks.get(key);
  if (!lock) {
    lock = { mutex: new Mutex(), queued: 0 };
    addressLocks.set(key, lock);
  }
  const held = lock;
  held.queued++;
  return held.mutex.run(fn).finally(() => {
    if (--held.queued === 0) addressLocks.delete(key);
  });
}

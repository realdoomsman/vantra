// Transaction helper with after-commit hooks, so bus emissions never describe a rolled-back write.
import { PgTransaction } from 'drizzle-orm/pg-core';
import type { DbLike, Tx } from '../db/client.js';

const hooks = new WeakMap<object, Array<() => void>>();

// Runs `fn` inside a transaction. When `db` already is a transaction it is reused (no savepoint),
// so nested calls share one commit and one set of after-commit hooks.
export async function withTx<T>(db: DbLike, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (db instanceof PgTransaction) return fn(db as Tx);
  let pending: Array<() => void> = [];
  const result = await db.transaction(async (tx) => {
    hooks.set(tx, pending);
    try {
      return await fn(tx);
    } finally {
      pending = hooks.get(tx) ?? [];
      hooks.delete(tx);
    }
  });
  for (const cb of pending) cb();
  return result;
}

// Defers `cb` until the enclosing withTx commits; runs immediately outside a transaction.
export function afterCommit(db: DbLike, cb: () => void): void {
  const pending = hooks.get(db);
  if (pending) pending.push(cb);
  else cb();
}

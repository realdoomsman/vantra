import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
// Anything that can run queries: the pool-backed Db or an open transaction.
export type DbLike = Db | Tx;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDb(databaseUrl: string, opts: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: opts.max ?? 10 });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

// Fails fast with an actionable message when the schema has not been applied.
export async function assertSchema(db: Db): Promise<void> {
  try {
    await db.execute(sql`select 1 from pool limit 1`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Database schema missing or unreachable (${msg}). Run: createdb vantra && pnpm db:push`);
  }
}

export { schema };

// Small helpers shared by every tool family.
import { eq } from 'drizzle-orm';
import type { Project } from '@vantra/shared';
import type { Config } from '../config.js';
import type { ToolResult } from '../core/interfaces.js';
import type { DbLike } from '../db/client.js';
import { agents, type AgentRow, type ProjectRow } from '../db/schema.js';

export const ok = (content: string, extra: Partial<ToolResult> = {}): ToolResult => ({ content, costMicro: 0, ...extra });
export const fail = (content: string, extra: Partial<ToolResult> = {}): ToolResult => ({ content, costMicro: 0, isError: true, ...extra });

// Tools re-read the agent row for anything money- or state-related: ctx.agent is a step-start snapshot.
export async function freshAgent(db: DbLike, id: string, lock = false): Promise<AgentRow> {
  const q = db.select().from(agents).where(eq(agents.id, id));
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw new Error(`agent ${id} not found`);
  return row;
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export const shortWallet = (w: string): string => (w.length > 12 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w);

export function fmtMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  const h = min / 60;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

export const cut = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

// Single-line preview of a JSON value for tool results and summaries.
export const previewJson = (v: unknown, max: number): string => cut(JSON.stringify(v) ?? 'null', max);

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id, agentId: row.agentId, name: row.name, kind: row.kind, status: row.status, url: row.url,
    description: row.description, revenueMicro: row.revenueMicro,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

// Public endpoint of a service; must match economy/mappers.ts:serviceEndpoint and the /svc route.
export const serviceEndpoint = (config: Pick<Config, 'apiUrl'>, serviceId: string): string => `${config.apiUrl}/svc/${serviceId}`;

export const isHttpUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

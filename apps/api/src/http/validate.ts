// Shared zod fragments for query strings, params and bodies. Parse failures become 400s via the error handler.
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

export const idParams = z.object({ id: z.string().min(1).max(64) });

export const limitQuery = (def: number, max: number) => z.coerce.number().int().min(1).max(max).default(def);
export const beforeQuery = z.coerce.number().int().positive().optional();

// POST routes whose fields are all optional accept an absent body.
export function parseBody<T>(schema: z.ZodType<T>, request: FastifyRequest): T {
  return schema.parse(request.body ?? {});
}

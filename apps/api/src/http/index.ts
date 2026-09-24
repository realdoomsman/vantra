import type { Deps, HttpServer } from '../core/interfaces.js';
import { createApp } from './server.js';

// Fastify app: auth (SIWS), routes, WS broadcast, static web in production; calls hosting/registerHosting. SPEC §8.14–§8.16; AMENDMENTS C25/C27.
export async function createServer(deps: Deps): Promise<HttpServer> {
  const { config, log } = deps;
  const app = await createApp(deps);
  return {
    async listen() {
      await app.listen({ port: config.port, host: config.host });
      log.info({ port: config.port, host: config.host, publicUrl: config.publicUrl }, 'http listening');
    },
    async close() {
      await app.close();
    },
  };
}

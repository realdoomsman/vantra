// SANDBOX_DRIVER=none: a deployment with no code sandbox at all (e.g. a host that cannot run Docker).
// Nothing can escape it because nothing runs in it. The registry withholds every SANDBOX_TOOLS entry,
// so no agent can reach the workspace methods below; if anything ever does, they throw.
//
// The lifecycle methods (ensure/start/stop/destroy) are called by spawn, sleep, wake, pause and death
// for every agent, and under `none` there is genuinely no workspace to create, stop or remove — so they
// complete without doing anything. Everything that would have to produce or consume workspace state
// (a command's output, a file's content, a directory listing, an export) throws instead.
import type { SandboxDriver } from '../core/interfaces.js';
import { SandboxUnavailableError } from './common.js';

const unavailable = (what: string): Promise<never> => Promise.reject(new SandboxUnavailableError(
  `${what} needs a code sandbox, and this deployment runs with SANDBOX_DRIVER=none`,
));

export function createNoSandbox(): SandboxDriver {
  return {
    name: 'none',
    ensure: () => Promise.resolve(),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
    exec: () => unavailable('running a command'),
    writeFile: () => unavailable('writing a file'),
    readFile: () => unavailable('reading a file'),
    listFiles: () => unavailable('listing files'),
    exportDir: () => unavailable('exporting a directory'),
  };
}

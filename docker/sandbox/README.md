# vantra-sandbox

The per-agent compute environment (SPEC §8.17). One container per agent, named `rw-<agentId>`, with a
named volume `rw-vol-<agentId>` mounted at `/work`.

## Build

The API never pulls or builds this image; build it once on the host before running with
`SANDBOX_DRIVER=docker`:

```sh
docker build -t vantra-sandbox:latest docker/sandbox
```

Override the tag with `SANDBOX_IMAGE`. If the image is missing, `sandbox.ensure()` fails with the build
command in the error message.

## What the image contains

`node:22-bookworm-slim` plus `python3`, `python3-pip`, `git`, `curl`, `ca-certificates`, `jq`. The user is
`agent` (uid/gid 1000, renamed from the base image's `node`), the workdir is `/work`, and no secrets are
baked in — agent wallet keys never leave the API process.

## Runtime flags (applied by `apps/api/src/sandbox/docker.ts`)

| Flag | Value |
|---|---|
| memory / swap | 512 MB, swap capped at the same value |
| cpus | 0.5 (`NanoCpus` 500,000,000) |
| pids-limit | 256 |
| capabilities | `--cap-drop ALL`, `--security-opt no-new-privileges` |
| filesystem | read-only root, `tmpfs /tmp` (rw,nosuid,256m), volume `rw-vol-<agentId>` at `/work` |
| network | `vantra-agents` bridge (host interface `br-vantra-agent`) — agents need egress |
| user | 1000:1000 |
| init | `Init: true` — docker-init (tini) as pid 1, not `sleep infinity` |
| logs | disabled (`LogConfig: none`); stdout/stderr are captured per exec |

### Why `Init: true`

Measured against a real daemon, not assumed. `sleep infinity` as pid 1 never calls `wait()`, so any command
that leaves a child behind (`npm run dev &`, or just `(sleep 1 &)`) reparents it to pid 1 and leaks a
permanent zombie: 40 such commands produced 40 zombies that never cleared. With `--pids-limit 256` a
long-lived agent therefore wedges its own container for good — every later exec fails with a runc
`Cannot fork` error and only `destroy` recovers it. The kernel also applies no default signal action to
pid 1, so `sleep infinity` ignored SIGTERM and every `docker stop` burned the full grace period (5117 ms
measured, versus 112 ms with tini) — which matters because sleeping and paused agents are stopped and
started constantly. `apps/api/test/sandbox/docker.integration.test.ts` asserts both properties.

### What the image does not contain

No `ps` — `node:22-bookworm-slim` omits `procps`. Agents inspecting their own processes must read `/proc`.

Commands run as `timeout -s KILL <n> sh -lc '<command>'`; if the exec outlives that by 3s the host kills the
container. CPU time comes from the `cpu_stats.cpu_usage.total_usage` delta around the exec, falling back to
wall-clock × 0.5 when stats are unavailable.

## Operating

- Sleeping and paused agents get `docker stop` (rent discount); the next step starts the container again.
- `sandbox.destroy()` removes the container and its volume — agent death is irreversible.
- Stale containers from a wiped database: `docker ps -aq --filter label=vantra.agent | xargs -r docker rm -f`
  and `docker volume ls -q --filter label=vantra.agent | xargs -r docker volume rm`.

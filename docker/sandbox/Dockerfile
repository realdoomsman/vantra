# Agent sandbox image (SPEC §8.17). Build: docker build -t vantra-sandbox:latest docker/sandbox
# Runtime flags are applied by apps/api/src/sandbox/docker.ts:
#   --memory 512m --cpus 0.5 --pids-limit 256 --cap-drop ALL --security-opt no-new-privileges
#   --read-only root, tmpfs /tmp, volume rw-vol-<agentId> at /work, default bridge network (egress only).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip git curl ca-certificates jq \
 && rm -rf /var/lib/apt/lists/*

# uid 1000 already exists as "node" in the base image; rename it so the sandbox user is "agent".
RUN usermod -l agent node && groupmod -n agent node && mkdir -p /work && chown agent:agent /work

USER agent
WORKDIR /work
ENV HOME=/tmp NPM_CONFIG_CACHE=/tmp/.npm PIP_NO_CACHE_DIR=1
CMD ["sleep", "infinity"]

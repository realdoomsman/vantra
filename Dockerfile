# VANTRA production image: the pnpm workspace built from the repository root, one process serving the
# API, the WebSocket feed, hosted agent sites and the built web app (apps/web/dist) on $PORT.
#
# Railway builds this file whenever it is at the root of the upload. It needs no Docker daemon at run
# time: deploy with SANDBOX_DRIVER=none (see apps/api/src/sandbox/none.ts) unless the host provides one.
#
#   build   pnpm install --frozen-lockfile && pnpm build     (shared → api → web, in dependency order)
#   migrate pnpm db:migrate                                    (Railway pre-deploy; drizzle migrations)
#   start   node apps/api/dist/index.js
#
# Dev dependencies stay in the image on purpose: the pre-deploy migration runs through tsx
# (apps/api `db:migrate`), and it must work from exactly the image that is about to serve.
FROM node:22-bookworm-slim

# No ARGs are declared, so none of the service's variables (secrets included) can reach a build layer.
ENV CI=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# The version pinned by package.json#packageManager, installed where every user can run it.
RUN npm install -g pnpm@10.13.1

WORKDIR /app

# .dockerignore keeps every .env*, node_modules, dist and data out of the context. The whole tree is
# copied before installing because packages/shared compiles itself in its `prepare` script.
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

# DATA_DIR (./data → /app/data) holds hosted agent sites. It is the container's ephemeral disk: it is
# wiped on every redeploy. Agent and deposit keys never touch it; they live encrypted in Postgres.
RUN mkdir -p /app/data && chown node:node /app/data

# Railway routes a domain to 8080 unless told otherwise, and injects PORT; both agree on 8080.
ENV NODE_ENV=production \
    PORT=8080
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/index.js"]

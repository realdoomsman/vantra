# Deploying VANTRA

`setup.sh` turns a fresh Ubuntu 22.04/24.04 VM into a running VANTRA node behind HTTPS. It never
contains secrets — it reads them from `$APP_DIR/secrets/` (which you copy to the box) and composes
`/opt/vantra/.env` there.

## What you provide once (only you can)

1. **A server.** A Google Cloud `e2-medium` (2 vCPU / 4 GB) Ubuntu 24.04 VM with HTTP+HTTPS allowed is
   plenty (agents run Docker containers, so ≥4 GB is comfortable). Note its external IP.
2. **DNS.** In Porkbun, point your domain's `A` record at that IP (and a `www` CNAME if you want).
3. **Brains.** Either an x402 LLM gateway URL (`LLM_PROVIDER=x402`, `X402_GATEWAY_URL=…`) or a provider
   key (`LLM_PROVIDER=router` + `ANTHROPIC_API_KEY`/…). Until then it runs `LLM_PROVIDER=mock`.

## The secrets bundle

Generated off-repo (never committed). The bundle is a directory `secrets/` containing:

```
treasury.key   escrow.key    # signing keys: one 0x-prefixed 32-byte hex private key per file
                             #   openssl rand -hex 32 > treasury.key   (prefix it with 0x)
kek.txt        session.txt   # KEY_ENCRYPTION_KEY, SESSION_SECRET
rpc-testnet.txt rpc-mainnet.txt   # your Robinhood Chain RPC URLs (the testnet one holds an Alchemy key)
usdc-testnet.txt             # the test USDC address you bridged — testnet only; mainnet uses the built-in USDC
```

The founder-fee and protocol-fee wallets are addresses you pass on the command line, not files: they are
destinations the server never signs for. Use a wallet you control (MetaMask/Rabby or a hardware wallet)
added to Robinhood Chain, chain id 4663.

## Bring-up

```sh
# from your machine, once the VM exists and DNS points at it:
scp -r ./secrets   user@SERVER_IP:/tmp/secrets
ssh user@SERVER_IP 'sudo mkdir -p /opt/vantra && sudo git clone https://github.com/humza2244/vantra /opt/vantra \
  && sudo mv /tmp/secrets /opt/vantra/secrets'
ssh user@SERVER_IP 'sudo DOMAIN=your-domain.com NETWORK=testnet \
  FOUNDER_ADDRESS=0xYourFounderFeeAddress \
  PROTOCOL_ADDRESS=0xYourProtocolFeeAddress \
  bash /opt/vantra/deploy/setup.sh'
```

`setup.sh` is idempotent — re-run it after `git pull` to redeploy. Then:

```sh
curl -s https://your-domain.com/api/health        # mode actually in force
journalctl -u vantra -f                          # logs
```

## Fund the treasury (testnet)

`pnpm ready` on the box prints the address derived from `treasury.key` — that is what you fund.

- ETH for gas: the Robinhood Chain testnet faucet, or bridge test ETH to that address.
- USDC: bridge test USDC to it. Not required to start — each purchase funds its own agent — but a float
  absorbs timing gaps.

## Going to mainnet

Only after you've watched a testnet purchase settle end to end. Re-run with `NETWORK=mainnet` (the script
adds `ALLOW_MAINNET=1` and leaves `USDC_ADDRESS` blank so the built-in mainnet USDC is used) and put a
mainnet endpoint in `rpc-mainnet.txt`. Read `docs/OPERATIONS.md` first.

## Railway (no Docker daemon)

Railway runs the app from the root `Dockerfile` but cannot give it a Docker daemon, so it deploys with
`SANDBOX_DRIVER=none`: agents run with no code sandbox, and `bash`, `write_file`, `read_file`,
`list_files`, `deploy_site` and the whole service market (`create_service`, `update_service`,
`list_services`, `call_service`) are withheld from every agent. The `PAID API` and `PRODUCT` launch
strategies are refused. Stored agent tools are not rewritten, so moving to a host with Docker and setting
`SANDBOX_DRIVER=docker` brings them back with no migration.

- **Build and start**: `Dockerfile` — `pnpm install --frozen-lockfile && pnpm build`, then
  `node apps/api/dist/index.js`, which also serves `apps/web/dist`.
- **Pre-deploy**: `pnpm db:migrate` (drizzle migrations in `apps/api/drizzle`).
- **Service settings** (Postgres, pre-deploy, healthcheck `/api/health`, draining window, domain, non-secret
  mode switches): `.railway/railway.ts`, applied with `railway config plan` / `railway config apply` (needs
  `pnpm add -Dw railway` first). Set every secret with `railway variables --set` before the first apply.
- **Upload**: `railway up` from the repo root. `.railwayignore` keeps every `.env*` except `.env.example`
  on this machine; `.dockerignore` keeps them out of image layers as well.
- **Disk**: the container filesystem is wiped on every redeploy. Only `DATA_DIR/sites` (hosted agent sites,
  which cannot be created without a sandbox) lives there; keys live encrypted in Postgres.

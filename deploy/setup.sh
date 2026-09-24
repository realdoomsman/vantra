#!/usr/bin/env bash
# VANTRA one-shot server deploy for a fresh Ubuntu 22.04/24.04 VM.
#
# It installs Docker, Node 22, pnpm, Postgres and Caddy; builds the sandbox image; composes the
# production .env from the secret files under $APP_DIR/secrets (which you scp there, never commit);
# runs SQL migrations; installs the agent-egress firewall (docs/OPERATIONS.md); and starts the API
# behind Caddy with automatic HTTPS. Idempotent: safe to re-run.
#
# Usage (on the VM, repo already at /opt/vantra):
#   sudo DOMAIN=your-domain.com NETWORK=testnet \
#        FOUNDER_ADDRESS=0xYourFounderFeeAddress \
#        PROTOCOL_ADDRESS=0xYourProtocolFeeAddress \
#        bash /opt/vantra/deploy/setup.sh
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN, e.g. your-domain.com}"
NETWORK="${NETWORK:-testnet}"                     # testnet (chain id 46630) | mainnet (chain id 4663)
FOUNDER_ADDRESS="${FOUNDER_ADDRESS:?set FOUNDER_ADDRESS (0x address that receives the founder fee)}"
PROTOCOL_ADDRESS="${PROTOCOL_ADDRESS:?set PROTOCOL_ADDRESS (0x address that receives swept agent spend)}"
APP_DIR="${APP_DIR:-/opt/vantra}"
SEC="$APP_DIR/secrets"
LLM_PROVIDER="${LLM_PROVIDER:-mock}"   # mock until you add a real brain; then x402 (+X402_GATEWAY_URL) or router (+a key)

log() { echo -e "\n=== $* ==="; }

# Testnet has no canonical stablecoin, so its address has to be stated; mainnet uses the built-in USDC.
SECRETS=(treasury.key escrow.key kek.txt session.txt "rpc-$NETWORK.txt")
[ "$NETWORK" = "testnet" ] && SECRETS+=("usdc-testnet.txt")
for f in "${SECRETS[@]}"; do
  [ -f "$SEC/$f" ] || { echo "missing secret: $SEC/$f — scp your secrets/ dir to $SEC first"; exit 1; }
done
USDC_ADDRESS=""
if [ -f "$SEC/usdc-$NETWORK.txt" ]; then USDC_ADDRESS="$(cat "$SEC/usdc-$NETWORK.txt")"; fi

log "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git postgresql postgresql-contrib iptables-persistent

log "Docker"
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
systemctl enable --now docker

log "Node 22 + pnpm"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm i -g pnpm@10.13.1

log "Caddy (automatic HTTPS)"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

log "Postgres database + role"
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='vantra'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE ROLE vantra LOGIN PASSWORD 'vantra_local';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='vantra'" | grep -q 1 || \
  sudo -u postgres createdb -O vantra vantra

log "Compose $APP_DIR/.env from secrets"
umask 077
cat > "$APP_DIR/.env" <<ENV
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
PUBLIC_URL=https://$DOMAIN
API_URL=https://$DOMAIN
DATABASE_URL=postgres://vantra:vantra_local@127.0.0.1:5432/vantra
SESSION_SECRET=$(cat "$SEC/session.txt")
KEY_ENCRYPTION_KEY=$(cat "$SEC/kek.txt")
CHAIN_MODE=robinhood
RHC_NETWORK=$NETWORK
RHC_RPC_URL=$(cat "$SEC/rpc-$NETWORK.txt")
USDC_ADDRESS=$USDC_ADDRESS
TREASURY_WALLET_SECRET=$SEC/treasury.key
ESCROW_WALLET_SECRET=$SEC/escrow.key
FOUNDER_FEE_WALLET=$FOUNDER_ADDRESS
PROTOCOL_FEE_WALLET=$PROTOCOL_ADDRESS
FOUNDER_FEE_BPS=1000
LLM_PROVIDER=$LLM_PROVIDER
SANDBOX_DRIVER=docker
SANDBOX_EGRESS_FILTERED=1
ENV
[ "$NETWORK" = "mainnet" ] && echo "ALLOW_MAINNET=1" >> "$APP_DIR/.env"
chown "$(stat -c%U "$APP_DIR")" "$APP_DIR/.env"

log "Build the app"
cd "$APP_DIR"
pnpm install --frozen-lockfile
pnpm build
docker build -t vantra-sandbox:latest "$APP_DIR/docker/sandbox"

log "Database migrations"
set -a; . "$APP_DIR/.env"; set +a
pnpm --filter @vantra/api db:migrate

log "Agent egress firewall (docs/OPERATIONS.md)"
# The bridge (br-vantra-agent) is created by the API on first agent run; the rule matches once it exists.
iptables -C DOCKER-USER -i br-vantra-agent -d 0.0.0.0/8,10.0.0.0/8,100.64.0.0/10,127.0.0.0/8,169.254.0.0/16,172.16.0.0/12,192.0.0.0/24,192.168.0.0/16,198.18.0.0/15,224.0.0.0/4,240.0.0.0/4 -j DROP 2>/dev/null || \
  iptables -I DOCKER-USER -i br-vantra-agent -d 0.0.0.0/8,10.0.0.0/8,100.64.0.0/10,127.0.0.0/8,169.254.0.0/16,172.16.0.0/12,192.0.0.0/24,192.168.0.0/16,198.18.0.0/15,224.0.0.0/4,240.0.0.0/4 -j DROP
ip6tables -C DOCKER-USER -i br-vantra-agent -d ::1/128,fc00::/7,fe80::/10,ff00::/8 -j DROP 2>/dev/null || \
  ip6tables -I DOCKER-USER -i br-vantra-agent -d ::1/128,fc00::/7,fe80::/10,ff00::/8 -j DROP
netfilter-persistent save

log "Caddy reverse proxy + TLS for $DOMAIN"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	reverse_proxy 127.0.0.1:8787
}
CADDY
systemctl reload caddy || systemctl restart caddy

log "systemd service"
cat > /etc/systemd/system/vantra.service <<UNIT
[Unit]
Description=VANTRA API
After=network.target postgresql.service docker.service
Wants=postgresql.service docker.service

[Service]
Type=simple
WorkingDirectory=$APP_DIR/apps/api
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now vantra
sleep 3
systemctl --no-pager status vantra | head -12 || true

log "Done"
echo "Health:  curl -s https://$DOMAIN/api/health"
echo "Logs:    journalctl -u vantra -f"
echo "Brains:  edit $APP_DIR/.env -> LLM_PROVIDER=x402 + X402_GATEWAY_URL (or router + a key), then: systemctl restart vantra"

#!/usr/bin/env bash
# ── Swarm Mind — Deploy Hub Dashboard to EigenCloud ──────────────────────
#
# Upgrades (or deploys) the central "Swarm Mind" app as the hub dashboard.
# The hub polls Kepler, Hubble, and Voyager and shows them in one unified UI.
#
# Prerequisites:
#   export ECLOUD_PRIVATE_KEY=0x...
#   export HUB_APP_ID=0x...          (app ID of existing Swarm Mind app)
#   export KEPLER_URL=http://...     (EigenCloud API address of Kepler)
#   export HUBBLE_URL=http://...     (EigenCloud API address of Hubble)
#   export VOYAGER_URL=http://...    (EigenCloud API address of Voyager)
#
# Usage:
#   bash scripts/deploy-hub.sh [path-to-env]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="${1:-.env}"

: "${ECLOUD_PRIVATE_KEY:?Set ECLOUD_PRIVATE_KEY}"
: "${HUB_APP_ID:?Set HUB_APP_ID=0x... (the Swarm Mind app ID)}"
: "${KEPLER_URL:?Set KEPLER_URL=http://... (Kepler EigenCloud API address)}"
: "${HUBBLE_URL:?Set HUBBLE_URL=http://... (Hubble EigenCloud API address)}"
: "${VOYAGER_URL:?Set VOYAGER_URL=http://... (Voyager EigenCloud API address)}"

IMAGE="${IMAGE:-docker.io/owizdom90/swarm-mind-hub:latest}"
ECLOUD_RPC_URL="${ECLOUD_RPC_URL:-https://ethereum-sepolia.publicnode.com}"

command -v docker >/dev/null || { echo "docker required"; exit 1; }
command -v ecloud >/dev/null || { echo "ecloud CLI required"; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "Env file not found: $ENV_FILE"; exit 1; }

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Swarm Mind — Hub Dashboard Deploy                       ║"
echo "║  Aggregates Kepler + Hubble + Voyager into one UI        ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Kepler:  $KEPLER_URL"
echo "  Hubble:  $HUBBLE_URL"
echo "  Voyager: $VOYAGER_URL"
echo ""

# ── Build + push hub image ────────────────────────────────────────────
echo "==> Building hub image: $IMAGE"
docker build --platform linux/amd64 -f Dockerfile.hub -t "$IMAGE" .
echo "==> Pushing: $IMAGE"
docker push "$IMAGE"

# ── Write hub env file ────────────────────────────────────────────────
TMP_ENV="$(mktemp)"
cp "$ENV_FILE" "$TMP_ENV"
cat >> "$TMP_ENV" <<EOF
AGENT_PORT=80
PEER_URLS=${KEPLER_URL},${HUBBLE_URL},${VOYAGER_URL}
EOF

echo "==> Upgrading hub app: $HUB_APP_ID"
ecloud compute app upgrade "$HUB_APP_ID" --image-ref "$IMAGE" --env-file "$TMP_ENV" --private-key "$ECLOUD_PRIVATE_KEY" --rpc-url "$ECLOUD_RPC_URL"

rm -f "$TMP_ENV"

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  Hub dashboard submitted to EigenCloud."
echo "  Once Running, it will aggregate all 3 agents."
echo ""
echo "  To redeploy later:"
echo "    HUB_APP_ID=$HUB_APP_ID \\"
echo "    KEPLER_URL=$KEPLER_URL \\"
echo "    HUBBLE_URL=$HUBBLE_URL \\"
echo "    VOYAGER_URL=$VOYAGER_URL \\"
echo "    bash scripts/deploy-hub.sh .env"
echo "══════════════════════════════════════════════════════════════"

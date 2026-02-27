#!/usr/bin/env bash
# ── Swarm Mind — Deploy 3 Separate EigenCloud Instances ──────────────────────
#
# Deploys Kepler, Hubble, and Voyager as independent EigenCloud workloads.
# Each runs inside its own Intel TDX enclave — hardware-enforced isolation.
# Agents discover each other via BitTorrent DHT after startup.
#
# Prerequisites:
#   export ECLOUD_PRIVATE_KEY=0x...
#   export IMAGE=docker.io/<you>/swarm-mind-agent:latest
#   export KEPLER_PEER_URL=https://<kepler-eigencloud-url>  (set after Kepler deploys)
#
# Usage:
#   bash scripts/deploy-eigen-agents.sh [path-to-env]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="${1:-.env}"

: "${ECLOUD_PRIVATE_KEY:?Set ECLOUD_PRIVATE_KEY}"
: "${IMAGE:=docker.io/owizdom90/swarm-mind-agent:latest}"

ECLOUD_RPC_URL="${ECLOUD_RPC_URL:-https://ethereum-sepolia.publicnode.com}"
ENVIRONMENT="${ECLOUD_ENVIRONMENT:-sepolia}"
INSTANCE_TYPE="${ECLOUD_INSTANCE_TYPE:-g1-standard-4t}"
NETWORK_ID="${NETWORK_ID:-swarm-mind-v2}"
RUN_ID="$(date +%Y%m%d-%H%M%S)"

command -v docker  >/dev/null || { echo "docker required"; exit 1; }
command -v ecloud  >/dev/null || { echo "ecloud CLI required — install from eigencloud.xyz"; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "Env file not found: $ENV_FILE"; exit 1; }

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Swarm Mind — EigenCloud 3-Agent Deploy                  ║"
echo "║  Each agent gets its own TDX enclave + TEE quote         ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── Build + push agent image ──────────────────────────────────────────
echo "==> Building agent image: $IMAGE"
docker build --platform linux/amd64 -f Dockerfile.agent -t "$IMAGE" .
echo "==> Pushing image: $IMAGE"
docker push "$IMAGE"

# ── Helper: deploy one agent instance ────────────────────────────────
deploy_agent() {
  local name="$1"
  local index="$2"
  local bootstrap="${3:-}"

  local app_name="swarm-${name,,}-${RUN_ID}"

  echo ""
  echo "==> Deploying $name (index=$index) as: $app_name"

  # Build env overrides (written to a temp file so ecloud --env-file picks them up)
  local tmp_env
  tmp_env="$(mktemp)"
  cp "$ENV_FILE" "$tmp_env"
  {
    echo "AGENT_INDEX=$index"
    echo "AGENT_PORT=3002"
    echo "DHT_PORT=4002"
    echo "NETWORK_ID=$NETWORK_ID"
    echo "DB_PATH=/data/swarm-agent.db"
    [[ -n "$bootstrap" ]] && echo "PEER_URLS=$bootstrap"
  } >> "$tmp_env"

  ecloud compute app deploy \
    --environment   "$ENVIRONMENT" \
    --name          "$app_name" \
    --image-ref     "$IMAGE" \
    --dockerfile    "Dockerfile.agent" \
    --env-file      "$tmp_env" \
    --instance-type "$INSTANCE_TYPE" \
    --private-key   "$ECLOUD_PRIVATE_KEY" \
    --rpc-url       "$ECLOUD_RPC_URL" \
    --log-visibility public \
    --skip-profile \
    --resource-usage-monitoring disable

  rm -f "$tmp_env"
  echo "  ✓ $name deployed: $app_name"
}

# ── Deploy Kepler first (no bootstrap — it becomes the DHT seed) ──────
deploy_agent "Kepler" 0 ""

echo ""
echo "┌─────────────────────────────────────────────────────────────┐"
echo "│  Kepler is live. Get its public URL from EigenCloud, then   │"
echo "│  set KEPLER_PEER_URL=https://<kepler-url> and re-run this   │"
echo "│  script with SKIP_KEPLER=1 to deploy Hubble and Voyager.    │"
echo "└─────────────────────────────────────────────────────────────┘"

if [[ "${SKIP_KEPLER:-0}" == "1" ]]; then
  : "${KEPLER_PEER_URL:?Set KEPLER_PEER_URL to Kepler's public EigenCloud URL}"
  deploy_agent "Hubble"  1 "$KEPLER_PEER_URL"
  deploy_agent "Voyager" 2 "$KEPLER_PEER_URL"

  echo ""
  echo "══════════════════════════════════════════════════════════════"
  echo "  All 3 agents deployed on EigenCloud."
  echo "  Each runs in an isolated TDX enclave."
  echo "  Agents will discover each other via DHT within ~30 seconds."
  echo ""
  echo "  Check TEE attestation quotes:"
  echo "    curl https://<kepler-url>/attestation | jq .compute"
  echo "    curl https://<hubble-url>/attestation  | jq .compute"
  echo "    curl https://<voyager-url>/attestation | jq .compute"
  echo "══════════════════════════════════════════════════════════════"
fi

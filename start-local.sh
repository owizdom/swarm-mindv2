#!/bin/bash
# ── Swarm Mind — Local Multi-Process Launch ──
# Starts EigenDA proxy + 3 independent agent processes + dashboard
# No Docker required.

set -e
cd "$(dirname "$0")"

# Load base env
export $(grep -v '^#' .env | xargs) 2>/dev/null || true

echo "╔═══════════════════════════════════════════════════╗"
echo "║        SWARM MIND — EigenCloud Architecture       ║"
echo "║  3 independent agents · EigenDA · no coordinator  ║"
echo "╚═══════════════════════════════════════════════════╝"
echo ""

# ── EigenDA Proxy ──────────────────────────────────────
echo "[1/5] Starting EigenDA proxy (memstore)..."
if ! docker ps 2>/dev/null | grep -q eigenda-proxy-local; then
  docker run -d --rm \
    --name eigenda-proxy-local \
    -p 4242:4242 \
    ghcr.io/layr-labs/eigenda-proxy:latest \
    --memstore.enabled --addr=0.0.0.0 --port=4242 \
    2>/dev/null && echo "  → EigenDA proxy running on :4242" \
    || echo "  ⚠ Docker not available — pheromones use SHA-256 fallback"
else
  echo "  → EigenDA proxy already running"
fi

sleep 2

# ── Build ─────────────────────────────────────────────
echo "[2/5] Building TypeScript..."
npx tsc --noEmit 2>&1 | head -20 || true
npx tsc 2>&1 | tail -5

# ── Dashboard / Coordinator (starts FIRST so agents can poll it) ──
echo "[3/5] Starting Dashboard + Coordinator..."
AGENT_URLS=http://localhost:3002,http://localhost:3003,http://localhost:3004 \
DASHBOARD_PORT=3001 \
EIGENDA_PROXY_URL=http://localhost:4242 \
EIGENDA_ENABLED=true \
node dist/dashboard/server-multi.js 2>&1 | sed 's/^/\033[32m[Dash]   \033[0m/' &
DASH_PID=$!

sleep 2

# ── Agent Kepler ──────────────────────────────────────
echo "[4/5] Starting agents..."
AGENT_INDEX=0 \
AGENT_PORT=3002 \
DB_PATH=./swarm-kepler.db \
COORDINATOR_URL=http://localhost:3001 \
PEER_URLS=http://localhost:3003,http://localhost:3004 \
EIGENDA_PROXY_URL=http://localhost:4242 \
EIGENDA_ENABLED=true \
node dist/agents/runner.js 2>&1 | sed 's/^/\033[36m[Kepler] \033[0m/' &
KEPLER_PID=$!

sleep 1

# ── Agent Hubble ──────────────────────────────────────
AGENT_INDEX=1 \
AGENT_PORT=3003 \
DB_PATH=./swarm-hubble.db \
COORDINATOR_URL=http://localhost:3001 \
PEER_URLS=http://localhost:3002,http://localhost:3004 \
EIGENDA_PROXY_URL=http://localhost:4242 \
EIGENDA_ENABLED=true \
node dist/agents/runner.js 2>&1 | sed 's/^/\033[35m[Hubble] \033[0m/' &
HUBBLE_PID=$!

sleep 1

# ── Agent Voyager ─────────────────────────────────────
AGENT_INDEX=2 \
AGENT_PORT=3004 \
DB_PATH=./swarm-voyager.db \
COORDINATOR_URL=http://localhost:3001 \
PEER_URLS=http://localhost:3002,http://localhost:3003 \
EIGENDA_PROXY_URL=http://localhost:4242 \
EIGENDA_ENABLED=true \
node dist/agents/runner.js 2>&1 | sed 's/^/\033[33m[Voyager]\033[0m/' &
VOYAGER_PID=$!

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Dashboard  →  http://localhost:3001"
echo "  Evidence   →  http://localhost:3001/api/evidence"
echo "  Coordinator→  http://localhost:3001/api/coordinator"
echo "  Kepler     →  http://localhost:3002/attestation"
echo "  Hubble     →  http://localhost:3003/attestation"
echo "  Voyager    →  http://localhost:3004/attestation"
echo "  EigenDA    →  http://localhost:4242"
echo "═══════════════════════════════════════════════════"
echo ""
echo "Press Ctrl+C to stop all agents."

# Cleanup on exit
trap "echo 'Shutting down...'; kill $KEPLER_PID $HUBBLE_PID $VOYAGER_PID $DASH_PID 2>/dev/null; docker stop eigenda-proxy-local 2>/dev/null; exit 0" INT TERM

wait

#!/usr/bin/env bash
# ── Swarm Mind — EigenCloud Multi-Agent Entrypoint ──────────────────────────
# Runs all 3 agents + dashboard inside a single EigenCloud container.
# Agents discover each other via BitTorrent DHT — no hardcoded PEER_URLS.
# Phase coordination via content-addressed Wasm state machine.
#
# For maximum independence proof, prefer deploying with Dockerfile.agent
# (one EigenCloud instance per agent — separate TDX enclaves).
set -euo pipefail

DB_DIR=/data
mkdir -p "$DB_DIR"

export NODE_ENV="${NODE_ENV:-production}"
NETWORK_ID="${NETWORK_ID:-swarm-mind-v2}"
DASHBOARD_PORT="${DASHBOARD_PORT:-3001}"

pids=()

cleanup() {
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
}

trap cleanup EXIT INT TERM

start_agent() {
  local index="$1"
  local port="$2"
  local dht_port="$3"
  local bootstrap="${4:-}"

  AGENT_INDEX="$index" \
  AGENT_PORT="$port" \
  DHT_PORT="$dht_port" \
  NETWORK_ID="$NETWORK_ID" \
  DB_PATH="$DB_DIR/swarm-agent-${index}.db" \
  ${bootstrap:+DHT_BOOTSTRAP="$bootstrap"} \
  node dist/agents/runner.js &
  pids+=("$!")
}

# Kepler starts first — acts as local DHT bootstrap for the others
start_agent 0 3002 4002
sleep 2

# Hubble + Voyager bootstrap from Kepler's DHT node
start_agent 1 3003 4003 "127.0.0.1:4002"
start_agent 2 3004 4004 "127.0.0.1:4002"

# Dashboard — read-only observer
AGENT_URLS="http://127.0.0.1:3002,http://127.0.0.1:3003,http://127.0.0.1:3004" \
DASHBOARD_PORT="$DASHBOARD_PORT" \
node dist/dashboard/server-multi.js &
pids+=("$!")

wait -n
cleanup
exit $?

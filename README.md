# Swarm Mind — NASA Science Mode

**Autonomous AI agents that collectively study NASA datasets, form scientific hypotheses, and produce cryptographically-attested research findings — without a leader.**

Built for the [EigenCloud Open Innovation Challenge](https://ideas.eigencloud.xyz/).

---

## Honest Note on EigenCompute

This project is designed for [EigenCompute](https://eigencompute.xyz) — general-purpose verifiable compute where every container runs inside a hardware TEE (Intel TDX) and gets a cryptographic proof of exactly what code ran. Combined with real EigenDA (KZG commitments attested by restaked ETH operators), this would be fully verifiable: anyone could prove the agents ran this exact code and that their findings are tamper-proof.

**I couldn't deploy there.** EigenCompute requires a paid subscription I don't have access to, and real EigenDA disperse on Holesky requires a funded Ethereum wallet.

What this submission does instead:

| Feature | What's Built | What's Missing |
|---------|-------------|----------------|
| Per-agent Ed25519 keypair | Every agent generates a keypair on startup; every pheromone is signed | On EigenCompute, this keypair would be hardware-generated inside the TEE enclave |
| EigenDA attestation | EigenDA proxy runs in `--memstore.enabled` mode — same API surface, same KZG commitment format | Without a funded Holesky wallet, blobs aren't dispersed to real restakers |
| TEE attestation | Code checks `EIGENCOMPUTE_INSTANCE_ID` env var and exposes `/attestation` endpoint | Without an actual TEE, attestation is software-signed, not hardware-bound |
| Decentralized agents | 3 fully independent containers — own SQLite, own keypair, own HTTP server, no coordinator | Fully implemented — this part works as designed |

The architecture is EigenCompute-ready. Deploying there would make the attestation real. The code handles both modes identically — the only difference is whether the hardware provides the root of trust.

---

## The Idea

Three AI agents — **Kepler**, **Hubble**, and **Voyager** — independently fetch live NASA data across five domains: near-Earth asteroids, solar flares, Earth events, exoplanets, and Mars weather. They form their own hypotheses, share findings through a pheromone signal channel, and collectively synthesize what they've learned.

Nobody tells them to cooperate. Nobody tells them what to find. Above a critical signal density, they spontaneously synchronize and produce a collective report — an emergent picture of space and Earth science built from live data.

Every finding is signed with the agent's Ed25519 keypair and anchored to the EigenDA proxy. In simulation mode, the commitment is local. On EigenCompute with a real EigenDA connection, it becomes a KZG polynomial commitment attested by EigenLayer restakers.

> *"Three independent agents. Five NASA APIs. One collective mind. All attested."*

---

## Research Foundation

| Paper | Key Insight | How We Use It |
|-------|------------|---------------|
| [Emergent Collective Memory](https://arxiv.org/abs/2512.10166) | Critical density threshold — above it, agents spontaneously synchronize | Phase transition model |
| [SwarmSys](https://arxiv.org/abs/2510.10047) | Pheromone-inspired coordination without central control | Pheromone channel architecture |
| [Phase Transitions in MAS](https://arxiv.org/abs/2508.08473) | Physical phase transition analogy — gas → crystal | Density computation |
| [SwarmAgentic](https://arxiv.org/abs/2506.15672) | Particle Swarm Optimization for evolving collaboration | Swarm movement model |
| [Darwin Godel Machine](https://arxiv.org/abs/2505.22954) | Self-improving agents through Darwinian selection | Knowledge evolution via pheromone reinforcement |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     PHEROMONE CHANNEL                           │
│          (gossip network — no central coordinator)              │
│                                                                 │
│  ╔═══════════════╗  ╔═══════════════╗  ╔═══════════════╗       │
│  ║    Kepler     ║  ║    Hubble     ║  ║   Voyager     ║       │
│  ║   Observer    ║  ║  Synthesizer  ║  ║   Analyst     ║       │
│  ║               ║  ║               ║  ║               ║       │
│  ║ Ed25519 key   ║  ║ Ed25519 key   ║  ║ Ed25519 key   ║       │
│  ║ own SQLite    ║  ║ own SQLite    ║  ║ own SQLite    ║       │
│  ║ own HTTP :3001║  ║ own HTTP :3002║  ║ own HTTP :3003║       │
│  ║               ║  ║               ║  ║               ║       │
│  ║ fetch NASA →  ║  ║ fetch NASA →  ║  ║ fetch NASA →  ║       │
│  ║ think →       ║  ║ synthesize →  ║  ║ correlate →   ║       │
│  ║ sign + emit   ║  ║ sign + emit   ║  ║ sign + emit   ║       │
│  ╚═══════════════╝  ╚═══════════════╝  ╚═══════════════╝       │
│         │  ▲               │  ▲               │  ▲             │
│         │  └───── gossip ──┘  └───── gossip ──┘  │             │
│         └────────────────────────────────────────┘             │
│                            │                                    │
│               ┌────────────▼────────────┐                      │
│               │   DENSITY > THRESHOLD?  │                      │
│               └────────────┬────────────┘                      │
│                            │ YES                                │
│               ╔════════════▼════════════╗                      │
│               ║     PHASE TRANSITION    ║                      │
│               ║   Collective memory     ║                      │
│               ║   LLM narrative report  ║                      │
│               ║   EigenDA anchoring     ║                      │
│               ╚═════════════════════════╝                      │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │       EigenDA Proxy     │
              │  blob → KZG commitment  │
              │  (memstore in sim mode) │
              └─────────────────────────┘
```

### No Central Coordinator

Each agent is a fully independent process:
- Its own SQLite database — no shared state
- Its own Ed25519 keypair — cryptographic identity
- Its own HTTP server — peers discover pheromones by polling
- Its own step loop — nothing tells it what to do

Pheromone propagation is pure gossip:
- Agent emits → POSTs to all peer URLs
- Agent polls peers every tick to absorb their pheromones
- Phase transition is detected locally by each agent independently

---

## How It Works

### Phase 1 — Exploration

Each agent scans its assigned NASA domain, caches the dataset, and emits a signed pheromone summary. Cross-pollination happens when an agent absorbs a peer's pheromone and follows its domain.

```
Density: ░░░░░░░░░░░░░░░░░░░░ 0.08
Kepler  → scanning near earth objects
Hubble  → scanning solar flares
Voyager → scanning exoplanets
```

### Phase 2 — Deep Analysis

As pheromone density grows, agents begin full LLM-powered science steps:

1. **Think** — form a hypothesis from what they've observed and absorbed
2. **Decide** — score candidate actions (`analyze_dataset`, `correlate_findings`, `share_finding`, `explore_topic`)
3. **Execute** — fetch real NASA data, run LLM analysis, emit a signed finding pheromone
4. **Persist** — finding written to SQLite + anchored to EigenDA proxy asynchronously

```
Density: ██████░░░░░░░░░░░░░░ 0.34
Kepler  → analyzing Asteroid & Comet Close Approaches
Hubble  → correlating solar flares + earth events
Voyager → sharing finding: exoplanet habitability patterns
tokens: 18.4k / 150k
```

### Phase 3 — Phase Transition

Density crosses the critical threshold. Agents synchronize. The swarm generates a **collective report**:

- Overview of what was studied
- Key findings with data references
- The swarm's own opinionated take
- What could have been done better
- A final verdict

```
Density: ████████████████████ 0.62
⚡ PHASE TRANSITION — COLLECTIVE INTELLIGENCE
[COLLECTIVE] Anchoring to EigenDA: 0x3af7b2c1…
```

---

## Running the Demo

### Prerequisites

- Node.js 22+
- Docker (for EigenDA proxy)
- An Anthropic API key (or OpenAI / EigenAI)

### Option A — Local processes (quickest for recording)

```bash
git clone <repo>
cd swarm-mind
npm install
npm run build
```

Copy and fill in your `.env`:

```bash
cp .env.example .env
# Set at minimum:
# ANTHROPIC_API_KEY=sk-ant-...
# NASA_API_KEY=DEMO_KEY   (or your real key)
```

Start the EigenDA proxy (simulated, no wallet needed):

```bash
docker run -d --name eigenda-proxy -p 4242:4242 \
  ghcr.io/layr-labs/eigenda-proxy:latest \
  --memstore.enabled --addr=0.0.0.0 --port=4242
```

Start all three agents + dashboard:

```bash
# Terminal 1 — Agent Kepler (Observer)
AGENT_INDEX=0 AGENT_PORT=3001 DB_PATH=/tmp/kepler.db \
PEER_URLS="http://localhost:3002,http://localhost:3003" \
node dist/agents/runner.js

# Terminal 2 — Agent Hubble (Synthesizer)
AGENT_INDEX=1 AGENT_PORT=3002 DB_PATH=/tmp/hubble.db \
PEER_URLS="http://localhost:3001,http://localhost:3003" \
node dist/agents/runner.js

# Terminal 3 — Agent Voyager (Analyst)
AGENT_INDEX=2 AGENT_PORT=3003 DB_PATH=/tmp/voyager.db \
PEER_URLS="http://localhost:3001,http://localhost:3002" \
node dist/agents/runner.js

# Terminal 4 — Dashboard
AGENT_URLS="http://localhost:3001,http://localhost:3002,http://localhost:3003" \
DASHBOARD_PORT=3000 \
node dist/dashboard/server-multi.js
```

Open `http://localhost:3000`.

---

### Option B — Docker Compose (cleanest for demo)

```bash
git clone <repo>
cd swarm-mind

# Fill in .env
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY (or other LLM provider)

docker compose up --build
```

That starts:
- `eigenda-proxy` — EigenDA proxy in memstore mode
- `agent-kepler` → port 3001
- `agent-hubble` → port 3002
- `agent-voyager` → port 3003
- `dashboard` → port 3000

Open `http://localhost:3000`.

To stop everything:

```bash
docker compose down
```

---

### Option C — Real EigenDA on Holesky (requires funded wallet)

Replace the EigenDA proxy command with:

```bash
docker run -p 4242:4242 ghcr.io/layr-labs/eigenda-proxy:latest \
  --eigenda-disperser-rpc=disperser-holesky.eigenda.xyz:443 \
  --eth-rpc=https://ethereum-holesky-rpc.publicnode.com \
  --eigenda-svc-manager-addr=0xD4A7E1Bd8015057293f0D0A557088c286942e84b \
  --eigenda-signer-private-key-hex=YOUR_FUNDED_HOLESKY_PRIVATE_KEY
```

Then run agents as in Option A. Pheromone blobs will be dispersed to real EigenDA operators and you'll get real KZG commitments back.

---

### Verifying Attestations

Check which agents are running and their cryptographic identities:

```bash
# Agent identities
curl http://localhost:3001/identity | jq .
curl http://localhost:3002/identity | jq .
curl http://localhost:3003/identity | jq .

# Latest attested pheromone from each agent
curl http://localhost:3001/attestation | jq .

# All attestations via dashboard
curl http://localhost:3000/api/attestations | jq .

# Aggregated swarm state
curl http://localhost:3000/api/state | jq .
```

The `/attestation` endpoint on each agent returns a verifiable proof containing the agent's public key, fingerprint, latest signed pheromone, and EigenDA commitment status.

---

## Configuration

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `SYNC_INTERVAL_MS` | `2000` | Time between agent steps |
| `PHEROMONE_DECAY` | `0.12` | How fast pheromone strength fades |
| `CRITICAL_DENSITY` | `0.55` | Density threshold for phase transition |
| `TOKEN_BUDGET_PER_AGENT` | `50000` | Max tokens per agent before scan-only fallback |

### LLM

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `anthropic` | `anthropic`, `openai`, or `eigenai` |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5` | Model to use |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `EIGENAI_API_KEY` | — | EigenAI API key |

### NASA

| Variable | Default | Description |
|----------|---------|-------------|
| `NASA_API_KEY` | `DEMO_KEY` | 30 req/hr with DEMO_KEY, 1000/hr with real key |

### EigenDA

| Variable | Default | Description |
|----------|---------|-------------|
| `EIGENDA_PROXY_URL` | `http://eigenda-proxy:4242` | EigenDA proxy URL — leave unset to use SHA-256 fallback only |

### EigenCompute (injected automatically when deployed there)

| Variable | Set By | Description |
|----------|--------|-------------|
| `EIGENCOMPUTE_INSTANCE_ID` | EigenCompute | Unique TEE instance identifier |
| `EIGENCOMPUTE_INSTANCE_TYPE` | EigenCompute | Hardware type (e.g. `tdx-v1`) |

---

## NASA Data Sources

| Dataset | API | What Agents Study |
|---------|-----|------------------|
| Near-Earth Objects | NASA NeoWs | Asteroid/comet close approaches, velocities, diameters, hazard rates |
| Solar Flares | NASA DONKI | X/M/C class flares, daily averages, peak events |
| Earth Events | NASA EONET | Active wildfires, storms, volcanoes, sea ice — real-time |
| Exoplanets | NASA Exoplanet Archive | Confirmed planets since 2022, super-Earths, hot Jupiters, habitable zone candidates |
| Mars Weather | Curiosity REMS | Surface temperatures, pressure, dust storm season, mission sol count |

All data is fetched live via public NASA REST APIs. A 15-minute in-memory cache prevents rate limit exhaustion.

---

## Agent Personalities

Each agent has a personality vector that shapes how it prioritizes actions:

| Agent | Role | Curiosity | Diligence | Boldness | Sociability | Natural Tendency |
|-------|------|-----------|-----------|----------|-------------|-----------------|
| Kepler | Observer | 0.9 | 0.7 | 0.3 | 0.5 | Explores widely, notices subtle patterns |
| Hubble | Synthesizer | 0.6 | 0.5 | 0.4 | 0.95 | Cross-pollinates, shares findings freely |
| Voyager | Analyst | 0.5 | 0.9 | 0.7 | 0.4 | Deep analysis, confident conclusions |

Personalities are perturbed by ±0.04 at startup so each run is unique.

---

## File Structure

```
swarm-mind/
├── agents/
│   ├── types.ts          # All type definitions
│   ├── agent.ts          # SwarmAgent — science steps, pheromone signing
│   ├── runner.ts         # Single-agent process entry point (independent container)
│   ├── keystore.ts       # Ed25519 keypair generation, sign, verify, attestation
│   ├── science.ts        # NASA API fetchers with 15-min in-memory cache
│   ├── thinker.ts        # LLM reasoning — thoughts, analysis, collective reports
│   ├── decider.ts        # Decision scoring and softmax selection
│   ├── executor.ts       # Action handlers (analyze, share, correlate, explore)
│   ├── eigenda.ts        # EigenDA Proxy client
│   ├── swarm.ts          # Legacy single-process orchestrator (kept for reference)
│   └── persistence.ts    # SQLite persistence
├── dashboard/
│   ├── index.html        # Real-time visualization (canvas, tabs, attestation panel)
│   └── server-multi.ts   # Dashboard server — aggregates from all 3 agent HTTP APIs
├── Dockerfile            # Multi-stage build (builder + runtime)
├── docker-compose.yml    # eigenda-proxy + 3 agents + dashboard
├── .env                  # Configuration (gitignored)
├── .env.example          # Template
├── package.json
├── tsconfig.json
└── README.md
```

---

## What the Dashboard Shows

Live at `http://localhost:3000`:

**Header** — step counter, pheromone count, total discoveries, sync status, token usage, channel density

**Live tab** — agent particles moving through 2D space, pheromone signals, sync lines post-transition, latest thoughts in chat bubbles, click any agent to focus

**Agents tab** — grid of agent cards with token usage bar, thought count, datasets analyzed, latest finding conclusion

**Thoughts tab** — real-time stream of agent reasoning conclusions with confidence scores

**Pheromones tab** — all active signals, color-coded by domain, decaying over time

**Collective tab** — LLM-written narrative reports generated at phase transition: overview, key findings, opinions, what could be better, verdict

**Report tab** — full swarm summary: datasets analyzed, top insights, per-agent summaries

**Verify tab** — per-agent cryptographic identity (Ed25519 fingerprint), EigenDA status, list of signed pheromones with attestation strings

---

## What Would Make This Fully Verifiable

The gap between this simulation and full EigenCompute verifiability is two things:

**1. Hardware TEE keypair**

Currently: each agent calls `crypto.generateKeyPairSync('ed25519')` in Node.js on startup. The private key lives in process memory.

On EigenCompute: the keypair is generated inside an Intel TDX enclave. The private key never leaves the hardware. The TDX attestation quote cryptographically binds the code hash to the public key. Anyone can verify this without trusting the operator.

**2. Real EigenDA disperse**

Currently: the EigenDA proxy runs with `--memstore.enabled`. KZG commitments are generated locally and stored in memory — same format, no real dispersal.

On Holesky / mainnet: the blob is chunked, distributed to EigenDA operator nodes, and each operator signs their chunk. The KZG commitment is only returned after a quorum of operators attest. The security is economic — restaked ETH is slashed if operators lie.

The code handles both identically. `isEnabled()` in `eigenda.ts` checks if `EIGENDA_PROXY_URL` is set. The `/attestation` endpoint on each agent already exposes everything needed for verification. Swap the deployment target and the attestation becomes real.

---

## Key Design Decisions

1. **No coordinator** — Phase transition is detected locally by each agent from the density of signals it has absorbed. No agent waits for permission.

2. **Real data, not simulated** — Agents fetch live NASA APIs every step. The swarm's knowledge evolves as actual space weather changes.

3. **Hybrid persistence** — SQLite for fast operational access, EigenDA proxy for tamper-evident anchoring. Every pheromone has both a local row and a DA commitment.

4. **Async attestation** — EigenDA disperse is fire-and-forget. Agent steps are never blocked by DA latency. The commitment updates in-place when confirmed.

5. **LLM-generated opinions** — Collective reports are written by the LLM in first person ("our analysis suggests…"), not data dumps. The swarm forms actual opinions.

6. **Budget-gated** — Each agent has a token budget. When exhausted, it falls back to lightweight scan-only mode. No runaway costs.

7. **Gossip, not broadcast** — Agents push pheromones to peers on emit and pull from peers on each tick. No message bus. No shared queue. Pure HTTP gossip.

---

## References

- [Emergent Collective Memory in Decentralized Multi-Agent AI Systems](https://arxiv.org/abs/2512.10166)
- [SwarmSys: Decentralized Swarm-Inspired Agents](https://arxiv.org/abs/2510.10047)
- [A Minimal Model for Emergent Collective Behaviors in Multi-Agent Systems](https://arxiv.org/abs/2508.08473)
- [SwarmAgentic: Towards Fully Automated Agentic System Generation](https://arxiv.org/abs/2506.15672)
- [Darwin Godel Machine: Open-Ended Evolution of Self-Improving Agents](https://arxiv.org/abs/2505.22954)
- [EigenDA Documentation](https://docs.eigenda.xyz)
- [EigenLayer Documentation](https://docs.eigenlayer.xyz)
- [EigenDA Proxy](https://github.com/Layr-Labs/eigenda-proxy)
- [EigenCloud Open Innovation Challenge](https://ideas.eigencloud.xyz/)

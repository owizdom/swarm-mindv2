# Swarm Mind

**Multi-agent AI with verifiable independent convergence — built on EigenDA, BitTorrent DHT, and a content-addressed Wasm state machine**

Three autonomous agents reason over real NASA science data in complete isolation. Before any of them sees each other's work, each seals its findings cryptographically. After all three reveal, anyone can prove the convergence was independent — not copied.

No coordinator. No central server. Agents discover each other over BitTorrent Mainline DHT and derive their current phase from the same content-addressed Wasm binary loaded independently by each process. Identical clock, identical rules, zero shared infrastructure.

---

## Live Proof (Actual Output)

Run the system and hit `/api/evidence`. This is real output from a completed cycle:

```json
{
  "cycleNumber": 1,
  "allCommitted": true,
  "allIndependentBeforeReveal": true,
  "commitments": [
    {
      "agentName": "Kepler",
      "kzgHash": "eigenda:0x010000f8d6...",
      "eigenDAReferenceBlock": 147667247,
      "committedViaEigenDA": true
    },
    {
      "agentName": "Hubble",
      "kzgHash": "eigenda:0x010000f8d6...",
      "eigenDAReferenceBlock": 147667247,
      "committedViaEigenDA": true
    },
    {
      "agentName": "Voyager",
      "kzgHash": "eigenda:0x010000f8d6...",
      "eigenDAReferenceBlock": 147667247,
      "committedViaEigenDA": true
    }
  ],
  "independenceChecks": [
    { "agentName": "Kepler",  "eigenDAReferenceBlock": 147667247, "commitWindowCloseBlock": 147667248, "independentBeforeReveal": true },
    { "agentName": "Hubble",  "eigenDAReferenceBlock": 147667247, "commitWindowCloseBlock": 147667248, "independentBeforeReveal": true },
    { "agentName": "Voyager", "eigenDAReferenceBlock": 147667247, "commitWindowCloseBlock": 147667248, "independentBeforeReveal": true }
  ],
  "integrityChecks": [
    { "agentName": "Kepler",  "passed": true },
    { "agentName": "Hubble",  "passed": true },
    { "agentName": "Voyager", "passed": true }
  ],
  "slashEvents": []
}
```

Every check is live — each agent fetches peers' blobs from EigenDA, hashes them, and compares against the registered `sealedBlobHash`. `passed: true` means the retrieved content matches exactly what was committed. `independentBeforeReveal: true` means the blob was sealed before the reveal window opened, as determined by the shared Wasm clock.

---

## Start Here: The Hardest Problem in Verifiability

### The message dissemination problem

The most impactful unsolved problem in distributed verifiability is deceptively simple to state: **can you prove that node B received a message from node A?**

The answer is no — and the proof of impossibility is informative about what you can and cannot build.

Non-repudiation of *origin* is achievable. If A signs a message with a private key, any party who holds the corresponding public key can verify that A produced that exact message. RFC 2479 formalizes this as "proof of origin evidence." But non-repudiation of *receipt* is a different evidence class entirely — it requires B to produce a signed acknowledgment, and there is no protocol mechanism that forces B to return that acknowledgment without B's active cooperation. RFC 2479 defines this as a separate, harder requirement. If B refuses to acknowledge, or if the network drops the packet, origin signatures are silent on the question of delivery.

In distributed networks, this becomes the message adversary problem studied in reliable broadcast theory. Byzantine Reliable Broadcast (BRB) protocols can guarantee that all honest nodes eventually deliver the same message — but only under explicit assumptions about quorum membership, network synchrony, and the fraction of Byzantine actors. Every such guarantee requires extra protocol-level machinery beyond raw message signing. If a node can silently drop or delay messages, no amount of post-hoc signature verification can reconstruct the delivery history.

The takeaway for system design: **proving who sent something is easy. Proving who received something, and when, is a protocol-design problem that cannot be solved at the cryptographic primitive level.** This means any claim about multi-agent independence that relies on "agent B never received agent A's message" is unprovable in general. You need a different approach.

### What we do instead

We reframe the problem. Instead of trying to prove that agents never communicated (impossible), we prove something weaker but still sufficient:

> **Each agent's analysis was cryptographically sealed to an externally-verifiable record before the earliest possible moment any peer's sealed content could have influenced it.**

This proof is constructible because:
1. EigenDA's batch header contains a reference block number — an Ethereum-consensus-anchored timestamp, not a local clock
2. The coordinator's reveal window opens at a defined wall-clock moment registered in the coordinator's public log
3. An agent whose blob was sealed at reference block R, where R precedes the coordinator-logged reveal-window-open block, could not have been influenced by peer reveals — those reveals didn't exist yet on any tamper-evident record

This does not prove the agent had no out-of-band communication channel. Nothing can prove that. It proves the more useful thing: **under the protocol's constraints, convergence implies temporal independence.**

---

## What EigenLayer Actually Provides

### The EigenLayer model

EigenLayer lets ETH stakers opt into AVSs (Actively Validated Services) by restaking their ETH, extending it to additional slashing conditions defined by each AVS. Operators run AVS-specific software and commit to tasks; if they provably violate those tasks, their restaked ETH is slashable. Slashing went live on Ethereum mainnet in April 2025.

The key architectural concept is the distinction between **objective faults** and **intersubjective faults**. The EIGEN token whitepaper formalizes this distinction:

- **Objective faults** are verifiable by any honest party from on-chain state alone. Examples: a validator signing two conflicting blocks, a DA operator signing attestations for data they cannot produce, an agent who committed a hash but revealed different content. These are slashable by smart contract execution alone.
- **Intersubjective faults** require social consensus about a claim that cannot be reduced to on-chain computation. Examples: was the LLM analysis correct? Did the agent reason in good faith? Is this oracle value true? These require EIGEN token holders to vote as a "backstop" when objective proof is unavailable.

This distinction is crucial for design. **Build your protocol so that the things you care about most are objectively checkable.** Don't try to make subjective claims (LLM accuracy) slashable — you can't. Focus slashability on protocol compliance: did the agent commit in the commit window? Does the revealed content match the committed hash?

### What EigenDA provides

EigenDA uses **KZG polynomial commitments** — a commitment scheme (Kate, Zaverucha, Goldberg 2010) where:
- The committer proves content was fixed at commitment time (binding)
- Any evaluation point of the committed polynomial can be opened without revealing the whole polynomial
- The data is not just hash-pinned — it is retrievable, enforced by DA sampling where EigenDA operators sign attestations for chunks they can actually produce. An operator who signs for unavailable data is slashable.

What a KZG commitment in EigenDA proves:
- Content C was fixed at the time of dispersal
- Content C is retrievable — operators with restaked ETH have committed to keeping it available
- The batch header contains a reference block number — an Ethereum-block-anchored timestamp

What it does not prove:
- That C is true or meaningful
- That C was produced without consulting a peer
- Delivery — only availability

### EigenCloud — hardware-isolated TEE execution (core)

EigenCloud runs each agent inside an **Intel TDX confidential VM** — a hardware-enforced trusted execution environment where:

- The enclave memory is encrypted by the CPU and inaccessible to any other process, the host OS, or the hypervisor
- On startup, the CPU generates a **TDX attestation quote** — a hardware-signed certificate binding the exact container image hash to the enclave instance
- The quote is available at a local HTTP endpoint inside the container and is fetched by `tee-attestation.ts` at startup

**Why this matters for Swarm Mind:**

The independence proof gets a hardware guarantee. Without EigenCloud, independence is *protocol-level* — agents commit before reveal, Wasm clock is shared, but a skeptic could argue "they're processes on the same machine." With EigenCloud:

| Layer | What it proves |
|-------|---------------|
| Protocol (Wasm clock) | Agents computed phase identically from same binary |
| Ed25519 commitment | Each agent sealed its findings before the reveal window |
| EigenDA KZG | The sealed blob is retrievable and content-pinned |
| **TDX enclave quote** | **Each agent ran in hardware-isolated memory — physically impossible to share state** |

The TDX quote is returned in every agent's `/attestation` response under `compute.teeAttestation`. Anyone can verify the quote against Intel's certificate chain to confirm the agent ran genuine EigenCloud TEE hardware.

**Deployment model — one enclave per agent:**

Three separate EigenCloud instances, one per agent. Each gets its own:
- Intel TDX enclave with isolated memory
- TDX attestation quote (different per instance — proves distinct hardware execution)
- Ed25519 keypair generated inside the enclave (hardware-rooted identity)

The three quotes together form a hardware-level independence certificate for the swarm.

### What Swarm Mind builds on top

Each agent operates as an **AVS-style operator**:
- Runs inside an EigenCloud TDX enclave — hardware-isolated memory
- Generates an Ed25519 keypair inside the enclave — hardware-rooted identity
- Fetches a TDX attestation quote at startup — hardware proof of what code is running
- Disperses the **complete sealed blob** (including independence proof) to EigenDA — receives a KZG commitment
- Reveals during the reveal window with pheromones carrying `preCommitRef`

---

## The Independence Problem and LLM Sycophancy

### The Lorenz mechanism

In 2011, Lorenz, Rauhut, Schweitzer, and Helbing ran controlled experiments in which participants made numerical estimates before and after seeing their peers' answers. The result was decisive: social influence *reduced* the crowd's accuracy while *increasing* its confidence. The mechanism is the destruction of diversity — the statistical cancellation of errors that makes independent aggregation powerful is eliminated when agents anchor to each other's outputs, even weakly. A crowd that thinks together makes correlated errors. A crowd that thinks independently makes uncorrelated errors that cancel.

This is not a bug in human psychology specific to humans. It is a structural property of any aggregation system: independence of inputs is a prerequisite for the error-cancellation property that makes aggregation more accurate than any individual.

### The LLM failure mode

Language models are susceptible to the Lorenz mechanism at an architectural level, not just a behavioral one. Sharma et al. (Anthropic, 2023) characterize sycophancy in LLMs — the tendency to produce outputs that match perceived user preferences rather than factual accuracy — and demonstrate that it is resistant to mitigation through prompting alone. It is a training-time property.

In a multi-agent LLM system with open gossip, Agent B reading Agent A's conclusion before forming its own is not neutral consumption of evidence — it is exposure to social influence that biases B toward agreement at the training-data level. The result is not N independent analyses but one analysis reflected N times with superficial variation.

Gossip-based multi-agent LLM systems are not wisdom amplifiers. They are sycophancy amplifiers. They produce high-confidence wrong answers with no internal mechanism for detection, because every agent observes apparent consensus as evidence of correctness — the same mechanism that produces cascade failures in human expert panels.

### The architectural fix

The only reliable fix is architectural: **enforce silence before commitment**. If agents cannot observe each other's outputs until after they have cryptographically sealed their own, the influence pathway is severed at the protocol level rather than patched at the prompt level. This is computational pre-registration — analogous to clinical trial pre-registration (commit hypotheses before observing outcomes) but with cryptographic rather than procedural enforcement.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                     phase-machine.wasm  (sha256: 595f95e8…)          │
│   content-addressed — each agent loads the same binary independently  │
│   computePhase(Date.now()) → explore | commit | reveal | synthesis    │
│   same binary + same wall-clock = same phase, zero coordination       │
└────────────────────────┬─────────────────────────────────────────────┘
                         │ loaded by each agent at startup
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  EigenCloud     │ │  EigenCloud     │ │  EigenCloud     │
│  TDX Enclave    │ │  TDX Enclave    │ │  TDX Enclave    │
│  ┌───────────┐  │ │  ┌───────────┐  │ │  ┌───────────┐  │
│  │ KEPLER    │  │ │  │ HUBBLE    │  │ │  │ VOYAGER   │  │
│  │ Observer  │  │ │  │Synthesizer│  │ │  │ Analyst   │  │
│  │ :3002     │  │ │  │ :3002     │  │ │  │ :3002     │  │
│  │ DHT :4002 │  │ │  │ DHT :4002 │  │ │  │ DHT :4002 │  │
│  └───────────┘  │ │  └───────────┘  │ │  └───────────┘  │
│  TDX quote ✓    │ │  TDX quote ✓    │ │  TDX quote ✓    │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         └───────────────────┴───────────────────┘
              BitTorrent Mainline DHT (BEP 5)
              peer discovery — no registry, no coordinator
                         ↕
                EigenDA Proxy :4242
       (SHA-256 fallback when Docker unavailable)
```

### Phase 1: EXPLORE (silence)

Agents analyze real NASA datasets with no gossip. Each agent accumulates pheromones locally — they do not push to peers, do not pull from peers. Pheromones remain invisible to other agents.

This is where independent thought forms. The diversity that makes aggregation meaningful is produced here, in isolation.

### Phase 2: COMMIT (one step, synchronous)

The Wasm clock transitions to commit. Each agent independently computes the same phase boundary from `Date.now()` without communicating. Each agent:

1. Constructs a `SealedBlob`: every content hash produced during exploration, the agent's Ed25519 public key, and an `independenceProof` — an Ed25519 signature over `agentId | sha256(sortedContentHashes)`
2. **Disperses the complete sealed blob to EigenDA** — the full blob including the independence proof is what gets stored and KZG-committed, so `sha256(retrieved blob) == sealedBlobHash` is verifiable by anyone
3. Receives a KZG commitment (SHA-256 fallback when EigenDA proxy unavailable)
4. Broadcasts `{ kzgHash, sealedBlobHash }` to peers discovered via DHT

### Phase 3: REVEAL (gossip)

The Wasm clock opens the reveal window. Agents begin pulling from and pushing to peers over direct HTTP connections to the URLs learned from DHT. Every pheromone emitted in this phase carries `preCommitRef` — a pointer back to the sealed blob's commitment hash.

### Phase 4: SYNTHESIS

The Wasm clock opens the synthesis window. Each agent independently generates a `CollectiveMemory` — a full LLM-written research report with `preCommitProofs` — then the clock resets to EXPLORE for the next cycle.

### Why Wasm wall-clock instead of a coordinator

The previous version polled a coordinator server for phase transitions. This reintroduced a central point of failure and trust: agents had to trust the coordinator's clock and couldn't verify it was running the same rules. A verifier had to trust the coordinator logs.

The Wasm state machine replaces this with a content-addressed binary:

- **Same binary = same rules**: `sha256(phase-machine.wasm) = 595f95e83e05c0fc1b316dd23ab3368735b1cb1cd5c4a34159adec95ba5574ca`. Any agent can verify it loaded the right module before trusting its phase output.
- **Deterministic**: `computePhase(nowMs, exploreMs, commitMs, revealMs, synthMs)` is pure arithmetic — no I/O, no state, no network. Given the same inputs, all agents get the same output.
- **No trust required**: the coordinator was trusted infrastructure. The Wasm binary is a verifiable artifact — operators can inspect `phase-machine.wat` and compile it themselves.
- **No single point of failure**: killing a coordinator kills all coordination. The Wasm clock is local to each process; no process can disrupt another's phase view.

Phase boundaries are objective in the same sense they were before — wall-clock Unix time is a shared reference — but now enforced by an auditable, content-addressed program rather than a server.

---

## The Evidence Bundle

After each cycle, the coordinator produces a machine-verifiable evidence bundle at `/api/evidence`. The bundle persists across cycles — the last completed cycle's data is always available even after the next cycle begins.

```json
{
  "cycleId": "f6db14b9-1b8e-4dde-9000-539f79289f1d",
  "cycleNumber": 1,
  "generatedAt": 1772006850000,
  "commitments": [
    {
      "agentName": "Kepler",
      "kzgHash": "eigenda:0x010000f8d6f84df842a025...",
      "eigenDABatchId": "96bd2dad1b4bf7deb58ccc0a04fb9b93",
      "eigenDAReferenceBlock": 147667247,
      "committedViaEigenDA": true,
      "sealedBlobHash": "31fb42381fe9a78e2ce6ae990c41b9d4...",
      "submittedAt": 1772006656860
    }
  ],
  "integrityChecks": [
    {
      "agentName": "Kepler",
      "committedSealedBlobHash": "31fb42381fe9a78e2ce6ae990c41b9d4...",
      "verificationUrl": "http://localhost:4242/get/0x010000f8d6...",
      "passed": true
    }
  ],
  "independenceChecks": [
    {
      "agentName": "Kepler",
      "eigenDAReferenceBlock": 147667247,
      "commitWindowCloseBlock": 147667248,
      "independentBeforeReveal": true
    }
  ],
  "allCommitted": true,
  "allIndependentBeforeReveal": true,
  "slashEvents": [],
  "verifierInstructions": "..."
}
```

### What a verifier checks

**Integrity check** (content matches commitment) — performed live by the coordinator:
```bash
# The coordinator already does this automatically — passed: true/false in the evidence bundle
# To verify manually:
COMMITMENT=$(curl -s http://localhost:3002/commit | jq -r '.commitmentHash' | sed 's/eigenda://')
curl -s "http://localhost:4242/get/$COMMITMENT" -o blob.bin
sha256sum blob.bin
# Compare against sealedBlobHash in /api/evidence
```

**Independence check** (sealed before reveal window):
```
eigenDAReferenceBlock < commitWindowCloseBlock
  → blob was batched to Ethereum before the reveal window opened
  → agent could not have been influenced by peer reveals
  (peer reveals did not exist on any tamper-evident record before this block)
```

**Domain convergence check** (independent agents reached same topic):
```bash
# Compare topicsCovered across all three sealed blobs
# Same topic + different contentHashes = genuinely independent analysis
# Same topic + same contentHashes would indicate copying (different hashes prove different analyses)
COMMITMENT=$(curl -s http://localhost:3002/commit | jq -r '.commitmentHash' | sed 's/eigenda://')
curl -s "http://localhost:4242/get/$COMMITMENT" | jq '{agent: .agentName, topics: .topicsCovered, findings: (.findings | length)}'
```

**Synthesis provenance check**:
```bash
curl http://localhost:3001/api/collective | jq '.[0].preCommitProofs'
# Contains commitment hashes for all three agents
# Collective report was synthesized after all three independently committed
```

---

## Agent Reasoning

Each agent is an LLM with a distinct personality vector:

| Agent | Specialization | Curiosity | Diligence | Boldness | Sociability |
|-------|---------------|-----------|-----------|----------|-------------|
| Kepler | Observer | 0.9 | 0.7 | 0.3 | 0.5 |
| Hubble | Synthesizer | 0.6 | 0.5 | 0.4 | 0.95 |
| Voyager | Analyst | 0.5 | 0.9 | 0.7 | 0.4 |

Personality shapes behavior via scoring in `decider.ts`: curiosity increases weight on `analyze_dataset` and `explore_topic`; sociability increases weight on `share_finding`; diligence+curiosity together increase weight on `correlate_findings`.

### Data sources (real NASA APIs)

| Topic | Source | What agents analyze |
|-------|--------|---------------------|
| Near-Earth Objects | NASA NeoWs API | Approach distances, velocities, hazard classification, size distribution |
| Solar Flares | DONKI API | X/M/C class events, peak flux, active region correlations |
| Earth Events | EONET API | Wildfire locations, storm tracks, event frequency by category |
| Exoplanets | NASA Exoplanet Archive | Detection methods, orbital parameters, habitability indicators |
| Mars Weather | InSight MAAS2 API | Temperature range, pressure, wind speed, seasonal patterns |

### The decision-thought cycle

Every agent step:

1. **Absorb** — ingest pheromones from channel (only during reveal phase)
2. **Think** — form a structured thought via LLM: `{reasoning, conclusion, suggestedActions, confidence}`
3. **Decide** — score candidate actions against personality, token budget, and novelty
4. **Execute** — fetch dataset, analyze, correlate, or share
5. **Emit** — if the execution produced an artifact, create a pheromone and emit it (locally during explore; gossiped during reveal)

Personality differences produce genuinely different outputs from the same data. Given the same solar flare dataset: Kepler hedges ("data suggests possible correlation"), Voyager asserts ("X-class flares preceded Kp≥6 storms in 7 of 9 cases"), Hubble connects ("this timing pattern matches the NEO approach clustering from cycle 3"). Three different analytical frames. The commit-reveal cycle proves divergence was natural, not manufactured.

---

## Swarm Coordination (Stigmergy)

Agent coordination follows the stigmergic model — indirect coordination through environmental modification (Grassé 1959; Dorigo et al. 1996).

In place of pheromone trails on a physical substrate, agents deposit **digital pheromones** into a shared channel:

- **Strength** — initializes at `0.5 + confidence × 0.3`, decays by `PHEROMONE_DECAY` each step
- **Connections** — IDs of pheromones that contributed to this one (provenance graph)
- **Domain** — the scientific topic area
- **Attestation** — Ed25519 signature binding content to agent identity and timestamp
- **preCommitRef** — commitment hash of the agent's sealed blob (reveal-phase only)

High-strength pheromones from peers attract agents in the same topical region during reveal. If Kepler emits a strong signal on "near earth objects," Voyager — drawn by the gradient — fetches the same dataset independently and forms its own analysis. The resulting double-coverage produces the domain overlap the verifier checks: two independent analyses of the same topic with different content hashes.

---

## Why This Matters

### AI governance and the unfalsifiable claim

"Five independent AI systems all agree" is currently an unfalsifiable claim. Independent analysis and one analysis reflected five times produce identical outputs and identical confidence levels. Without verifiability infrastructure, there is no mechanism to distinguish them. This matters for:

- **Policy recommendations** — AI consortia advising governments on technical questions
- **Medical AI** — independent review systems that may share training data and gossip channels
- **Financial models** — risk assessments from ostensibly independent AI services

Swarm Mind makes this claim auditable. Commitments are registered on a coordinator with coordinator-side timestamps; blobs are retrievable from EigenDA; the independence check is a direct comparison of Ethereum block numbers.

### Decentralized AI oracles

Smart contracts consuming AI-generated data need guarantees analogous to what decentralized price oracles provide for market data: multiple independent sources, with independence proven rather than assumed. A single attested AI source is a single point of failure; N gossiping AI sources are one correlated source with N faces. Verifiable independent convergence — where each source committed before seeing the others — is the AI-native version of a decentralized oracle network.

### AI safety through independent verification

One proposed mechanism for detecting misaligned AI is disagreement between independently operating systems. This safety signal only works if the systems are genuinely independent. If agents can observe each other's outputs, their errors become correlated and the disagreement-detection property is destroyed. Verifiable independence is a prerequisite for using multi-agent disagreement as a safety signal at all.

### Epistemic security (cascade attack resistance)

In a gossip-based multi-agent system, compromising one high-betweenness agent poisons the entire network through the Lorenz mechanism. Commit-reveal destroys this attack surface: there is no influence pathway during explore. An adversary must compromise each agent independently before it commits — N times harder than compromising a single hub node.

### Scientific pre-registration

Clinical trial pre-registration is commit-reveal applied to hypothesis formation: researchers seal predictions before observing outcomes, preventing post-hoc rationalization. Swarm Mind is computational pre-registration — agents cannot adjust findings after seeing what peers concluded, and the temporal ordering is proven by Ethereum block numbers rather than procedurally asserted by a journal editor.

---

## Running Locally

**Prerequisites:** Node.js 20+, Docker (optional — SHA-256 fallback works without it)

```bash
git clone https://github.com/owizdom/swarm-mindv2
cd swarm-mindv2
cp .env.example .env
# Set LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY for AI synthesis
# NASA_API_KEY=DEMO_KEY is included (30 req/hr free; get a key at api.nasa.gov for 1000/hr)

npm install
npm run build   # tsc + copies phase-machine.wasm to dist/
npm run start:multi
```

`npm run start:multi` runs `start-local.sh` which:
1. Kills any stale processes on ports 3001–3004 and 4002–4004
2. Pulls and starts the EigenDA proxy (memstore, no wallet needed) on port 4242
3. Starts the dashboard (read-only observer) on port 3001
4. Starts agents Kepler, Hubble, Voyager on ports 3002–3004

Kepler bootstraps the local DHT mesh on port 4002. Hubble and Voyager join via `DHT_BOOTSTRAP=127.0.0.1:4002`. Within ~10 seconds all three agents find each other and begin the commit-reveal cycle — no registry, no handshake beyond the DHT announce.

**Dashboard:** `http://localhost:3001`
**Agent attestation:** `http://localhost:3002/attestation` (and :3003, :3004)

Without Docker, commitments fall back to `sha256:` hashes. The protocol is identical; the trust assumption changes — a sha256 hash has no retrievability guarantee or external timestamp.

### Deploy to EigenCloud (production — 3 separate TDX enclaves)

```bash
# 1. Install the ecloud CLI
#    → https://docs.eigencloud.xyz

# 2. Build and push the single-agent image
export IMAGE=docker.io/<you>/swarm-mind-agent:latest
docker build --platform linux/amd64 -f Dockerfile.agent -t $IMAGE .
docker push $IMAGE

# 3. Deploy Kepler first (it seeds the DHT mesh)
export ECLOUD_PRIVATE_KEY=0x...
bash scripts/deploy-eigen-agents.sh .env

# 4. Get Kepler's public URL from EigenCloud dashboard, then deploy Hubble + Voyager
export KEPLER_PEER_URL=https://<kepler-instance>.eigencloud.app
SKIP_KEPLER=1 bash scripts/deploy-eigen-agents.sh .env

# 5. Verify TEE attestation on each agent
curl https://<kepler-url>/attestation | jq '.compute.teeAttestation'
# → { teeType: "tdx", quoteSha256: "...", fetchedAt: ... }
# All three agents show different quoteSha256 — each has its own TDX enclave
```

Or use the all-in-one image (3 agents in one container — simpler, weaker isolation):
```bash
export IMAGE=docker.io/<you>/swarm-mind:latest
APP_NAME=swarm-mind bash scripts/deploy-eigen-all.sh .env
```

### Verify the Wasm binary

```bash
# All agents log this at startup — hashes must match across all three
# [WasmPhase] hash = 595f95e83e05c0fc1b316dd23ab3368735b1cb1cd5c4a34159adec95ba5574ca

# Recompile from source and verify yourself:
npm run compile:wasm
shasum -a 256 agents/phase-machine.wasm
# Must equal: 595f95e83e05c0fc1b316dd23ab3368735b1cb1cd5c4a34159adec95ba5574ca
```

### Watch the cycle

```bash
# Follow agent phase in real time (Wasm-derived — no coordinator needed)
watch -n2 'curl -s http://localhost:3002/attestation | jq "{phase: .cyclePhase, cycle: .wasmCycle, wasm: .wasmPhaseModule}"'

# Watch all three agents' phases simultaneously
watch -n2 'for p in 3002 3003 3004; do curl -s http://localhost:$p/attestation | jq "{port: '$p', phase: .cyclePhase, cycle: .wasmCycle}"; done'

# Follow agent thoughts as they form
watch -n3 'curl -s http://localhost:3002/thoughts | jq ".[0] | {conclusion, confidence}"'

# Watch DHT peer discovery
watch -n5 'curl -s http://localhost:3002/attestation | jq ".dhtPeers"'
```

### Verify a cycle manually

```bash
# Step 1: Check each agent's Wasm phase — all three must show the same cycle number
for p in 3002 3003 3004; do
  curl -s http://localhost:$p/attestation | jq '{port: '$p', phase: .cyclePhase, cycle: .wasmCycle, wasm: .wasmPhaseModule}'
done

# Step 2: Retrieve a sealed blob and inspect it
COMMITMENT=$(curl -s http://localhost:3002/commit | jq -r '.commitmentHash' | sed 's/sha256://' | sed 's/eigenda://')
curl -s "http://localhost:4242/get/$COMMITMENT" | jq '{
  agent:    .agentName,
  sealedAt: .explorationEndedAt,
  topics:   .topicsCovered,
  findings: (.findings | length),
  proof:    .independenceProof[:80]
}'

# Step 3: Manually verify integrity (SHA-256 fallback)
# sealedBlobHash is in the agent's /commit response
curl -s http://localhost:3002/commit | jq '{hash: .sealedBlobHash, commitment: .commitmentHash}'

# Step 4: Read the collective report
curl -s http://localhost:3002/collective | jq '.[0] | {
  preCommitProofs,
  overview:    .report.overview,
  keyFindings: .report.keyFindings,
  verdict:     .report.verdict
}'

# Step 5: Confirm all three agents show same Wasm module hash
for p in 3002 3003 3004; do
  curl -s http://localhost:$p/attestation | jq -r '":'+$p+' wasm=" + .wasmPhaseModule'
done
# All three must print the same hash prefix
```

---

## API Reference

### Dashboard (port 3001 — read-only observer)

| Endpoint | Description |
|----------|-------------|
| `/api/state` | Aggregated swarm state polled from all three agents |
| `/api/attestations` | Agent attestations merged from :3002–3004 |
| `/api/collective` | Collective memories aggregated from all agents |
| `/api/thoughts` | All agent thoughts, merged and sorted |
| `/api/pheromones` | All pheromones in channel |
| `/api/evidence` | Evidence bundle assembled from per-agent `/evidence` endpoints |

### Per-agent (ports 3002–3004)

| Endpoint | Description |
|----------|-------------|
| `/attestation` | Full agent attestation: identity, Wasm phase module hash, DHT peers, stats |
| `/commit` | Agent's current commitment hash and sealed blob hash |
| `/evidence` | Agent-local view of all known peer commitments |
| `/pheromones` | Agent's local pheromone channel |
| `/thoughts` | Agent's thoughts (last 50) |
| `/collective` | Collective memories generated by this agent |
| `/state` | Full agent state including Wasm cycle phase and commitment hash |
| `/identity` | Ed25519 public key and fingerprint |
| `/health` | LLM rate limit status |

---

## Configuration

```bash
# ── LLM Provider (optional — agents work without one) ──
LLM_PROVIDER=anthropic        # anthropic | openai | eigenai
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-4-6
# Note: free-tier Anthropic is 5 req/min — 3 agents will hit this limit.
# Tier 1 (any paid usage) raises to 50 req/min which works comfortably.

# ── NASA (DEMO_KEY = free, 30 req/hr) ──
NASA_API_KEY=DEMO_KEY
# Get a free key at api.nasa.gov for 1,000 req/hr

# ── EigenDA ──
EIGENDA_ENABLED=true
EIGENDA_PROXY_URL=http://localhost:4242
# Without Docker: commitments use sha256: fallback automatically

# ── Cycle timing (passed to Wasm computePhase at runtime) ──
EXPLORE_MS=30000     # 30s of silence — independent analysis window
COMMIT_MS=6000       # 6s — agents seal and broadcast commitments
REVEAL_MS=24000      # 24s — gossip, cross-pollination
SYNTHESIS_MS=12000   # 12s — LLM collective report, then next cycle

# ── DHT peer discovery ──
# Set per-agent in start-local.sh (not in .env):
# DHT_PORT=4002           # UDP port for BitTorrent DHT
# NETWORK_ID=swarm-mind-v2  # infohash namespace
# DHT_BOOTSTRAP=127.0.0.1:4002  # Hubble + Voyager bootstrap from Kepler

# ── Swarm dynamics ──
PHEROMONE_DECAY=0.12
CRITICAL_DENSITY=0.55
TOKEN_BUDGET_PER_AGENT=50000
SYNC_INTERVAL_MS=2000
```

---

## References

### Verifiability and distributed systems

- **Non-repudiation of receipt**: ITU-T (2000). *RFC 2479: Non-Repudiation Framework for Internet Commerce.* — Formalizes the distinction between proof-of-origin evidence (achievable via signing) and proof-of-receipt evidence (requires active cooperation from the receiver; cannot be forced cryptographically).

- **Byzantine reliable broadcast**: Civit, P., Gilbert, S., & Guerraoui, R. (2023). *Optimally resilient and fast Byzantine reliable broadcast with self-recovery.* Theoretical Computer Science — Proves why "did B receive A's message?" requires protocol-level architecture, not just cryptographic primitives.

- **Byzantine fault tolerance**: Lamport, L., Shostak, R., & Pease, M. (1982). The Byzantine Generals Problem. *ACM TOPLAS* 4(3), 382–401.

- **Practical BFT**: Castro, M., & Liskov, B. (1999). Practical Byzantine Fault Tolerance. *OSDI 1999*, 173–186.

### EigenLayer and data availability

- **EigenLayer whitepaper**: Eigenlabs (2023). *EigenLayer: The Restaking Collective.* — Introduces restaking, AVS architecture, and the objective/intersubjective fault distinction.

- **EIGEN token whitepaper**: Eigenlabs (2023). *EIGEN: The Universal Intersubjective Work Token.* — Formalizes intersubjective fault handling via EIGEN token holder adjudication.

- **Data availability proofs**: Al-Bassam, M., Sonnino, A., & Buterin, V. (2018). Fraud and Data Availability Proofs. *arXiv:1809.09044.*

- **KZG commitments**: Kate, A., Zaverucha, G.M., & Goldberg, I. (2010). Constant-Size Commitments to Polynomials and Their Applications. *ASIACRYPT 2010*, LNCS 6477, 177–194.

- **EIP-4844**: Buterin, V., et al. (2022). EIP-4844: Shard Blob Transactions.

### The independence problem

- **Lorenz mechanism**: Lorenz, J., Rauhut, H., Schweitzer, F., & Helbing, D. (2011). How social influence can undermine the wisdom of crowd effect. *PNAS* 108(22), 9020–9025.

- **LLM sycophancy**: Sharma, M., et al. (Anthropic, 2023). Towards Understanding Sycophancy in Language Models. *arXiv:2310.13548.*

- **Wisdom of crowds**: Galton, F. (1907). Vox Populi. *Nature* 75(1949), 450–451.

- **Cognitive diversity**: Hong, L., & Page, S.E. (2004). Groups of diverse problem solvers can outperform groups of high-ability problem solvers. *PNAS* 101(46), 16385–16389.

### Swarm intelligence and stigmergy

- **Stigmergy (original)**: Grassé, P.P. (1959). La reconstruction du nid et les coordinations inter-individuelles. *Insectes Sociaux* 6(1), 41–80.

- **Ant Colony Optimization**: Dorigo, M., Maniezzo, V., & Colorni, A. (1996). Ant System: Optimization by a Colony of Cooperating Agents. *IEEE SMC* 26(1), 29–41.

- **Swarm intelligence**: Bonabeau, E., Dorigo, M., & Theraulaz, G. (1999). *Swarm Intelligence: From Natural to Artificial Systems.* Oxford University Press.

### Trusted execution

- **Intel SGX**: Costan, V., & Devadas, S. (2016). Intel SGX Explained. *IACR ePrint* 2016/086.

### Peer-to-peer and Wasm

- **BitTorrent DHT (BEP 5)**: Loewenstern, A. & Norberg, A. (2008). *DHT Protocol.* bittorrent.org/beps/bep_0005.html — Kademlia-based distributed hash table used for peer discovery without a central tracker.

- **WebAssembly**: Haas, A., et al. (2017). Bringing the Web up to Speed with WebAssembly. *PLDI 2017.* — Used here as a content-addressed, deterministic computation substrate for the shared phase state machine.

---

*Built on EigenLayer (EigenDA), BitTorrent Mainline DHT, a content-addressed Wasm state machine, and the NASA Open APIs.*

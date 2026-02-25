# Swarm Mind

**Multi-agent AI with verifiable independent convergence — built on EigenDA**

Three autonomous agents reason over real NASA science data in complete isolation. Before any of them sees each other's work, each seals its findings cryptographically to EigenDA. After all three reveal, anyone can prove the convergence was independent — not copied.

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

Every check is live — the coordinator fetches each blob from EigenDA, hashes it, and compares against the registered `sealedBlobHash`. `passed: true` means the retrieved content matches exactly what was committed. `independentBeforeReveal: true` means the blob was sealed to Ethereum before the reveal window opened.

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

### What Swarm Mind builds on top

Each agent operates as an **AVS-style operator**:
- Registers with the coordinator on startup
- Has a defined task: analyze NASA datasets and commit findings before the commit window closes
- Disperses the **complete sealed blob** (including independence proof) to EigenDA — receives a KZG commitment anchored to an Ethereum block
- Registers `{ kzgHash, eigenDABatchId, eigenDAReferenceBlock }` with the coordinator
- Reveals during the reveal window with pheromones carrying `preCommitRef`

Objective faults the coordinator tracks:
- **Missed commit**: agent did not register before commit window closed → slash event recorded
- **Late commit**: agent submitted after the window → slash event with `fault: "missed_commit"`

The coordinator is currently a lightweight server; in production, this would be an on-chain contract enforcing windows with actual ETH slashing.

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
╔═══════════════════════════════════════════════════════════════════════╗
║             COORDINATOR + DASHBOARD  (port 3001)                     ║
║   Manages objective phase clock. Agents poll /api/coordinator        ║
║   Phase: explore → commit → reveal → synthesis → explore             ║
╠═══════════════════╦═══════════════════╦═══════════════════════════════╣
║   KEPLER (3002)   ║   HUBBLE  (3003)  ║   VOYAGER (3004)             ║
║   Observer        ║   Synthesizer     ║   Analyst                    ║
║   High curiosity  ║   High sociability║   High diligence/boldness     ║
╚═══════════════════╩═══════════════════╩═══════════════════════════════╝
                              ↕ EigenDA Proxy (port 4242)
```

### Phase 1: EXPLORE (silence)

Agents analyze real NASA datasets with no gossip. Each agent accumulates pheromones locally — they do not push to peers, do not pull from peers. Pheromones remain invisible to other agents.

This is where independent thought forms. The diversity that makes aggregation meaningful is produced here, in isolation.

### Phase 2: COMMIT (one step, synchronous)

The coordinator's commit window opens. Each agent:

1. Constructs a `SealedBlob`: every content hash produced during exploration, the agent's Ed25519 public key, the EigenCompute TEE instance ID, and an `independenceProof` — an Ed25519 signature over `agentId | eigenDAReferenceBlock | sha256(sortedContentHashes)`
2. **Disperses the complete sealed blob to EigenDA** — the full blob including the independence proof is what gets stored and KZG-committed, so `sha256(retrieved blob) == sealedBlobHash` is verifiable by anyone
3. Receives a KZG commitment and the batch's **Ethereum reference block number** (objective timestamp, not local clock)
4. Registers `{ kzgHash, eigenDABatchId, eigenDAReferenceBlock, sealedBlobHash }` with the coordinator

The `eigenDAReferenceBlock` is the objective anchor. It is the Ethereum block number at which the EigenDA batch containing this blob was finalized. No agent controls this number; it is determined by Ethereum consensus.

### Phase 3: REVEAL (gossip)

The coordinator opens the reveal window — one block after the commit window closes, making `eigenDAReferenceBlock < commitWindowCloseBlock` provably true. Agents begin pulling from and pushing to peers. Every pheromone emitted in this phase carries `preCommitRef` — a pointer back to the sealed blob's commitment hash.

### Phase 4: SYNTHESIS

The coordinator opens the synthesis window. Each agent generates a `CollectiveMemory` containing a full LLM-written research report with `preCommitProofs` — the commitment hashes of all three agents. The coordinator resets to EXPLORE, beginning the next cycle.

### Why coordinator-driven instead of density-based

The previous version used a local pheromone density heuristic: when density exceeded a threshold, each agent independently declared phase transition. This had a fundamental verifiability problem — "density" is a local variable computed differently by each agent, with no external reference. A verifier cannot reconstruct what density each agent observed or why they fired at a particular moment.

The coordinator-driven approach replaces this with a wall-clock timer that all agents poll. Phase boundaries are now:
- **Objective**: any external observer can verify when each window opened and closed
- **Consistent**: all agents react to the same phase signal
- **Auditable**: the coordinator logs commit registrations with coordinator-side timestamps (not agent-claimed timestamps)

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

**Prerequisites:** Node.js 20+, Docker

```bash
git clone https://github.com/owizdom/swarm-mindv2
cd swarm-mindv2
cp .env.example .env
# Optional: add LLM API key for AI synthesis (works without one)
# NASA_API_KEY=DEMO_KEY is included and works at 30 req/hr

npm install
npm run build
npm run start:multi
```

`npm run start:multi` runs `start-local.sh` which:
1. Pulls and starts the EigenDA proxy (memstore, no wallet needed) on port 4242
2. Starts the coordinator + dashboard on port 3001
3. Starts agents Kepler, Hubble, Voyager on ports 3002–3004 with `COORDINATOR_URL` and `EIGENDA_PROXY_URL` set

**Dashboard:** `http://localhost:3001`
**Evidence bundle:** `http://localhost:3001/api/evidence`
**Coordinator state:** `http://localhost:3001/api/coordinator`

Without Docker, commitments fall back to `sha256:` hashes. The protocol is identical; the trust assumption changes — a sha256 hash has no retrievability guarantee or external timestamp.

### Watch the cycle

```bash
# Follow coordinator phase in real time
watch -n2 'curl -s http://localhost:3001/api/coordinator | jq "{cycle: .cycleNumber, phase: .phase, window: .windowRemainingMs, commits: .commitCount}"'

# Watch the evidence bundle fill in
watch -n5 'curl -s http://localhost:3001/api/evidence | jq "{cycle: .cycleNumber, committed: .allCommitted, independent: .allIndependentBeforeReveal, integrityPassed: [.integrityChecks[].passed]}"'

# Follow agent thoughts as they form
watch -n3 'curl -s http://localhost:3002/thoughts | jq ".[0] | {conclusion, confidence}"'
```

### Verify a cycle manually

```bash
# Step 1: Get the full evidence bundle (persists across cycles)
curl http://localhost:3001/api/evidence | jq '{
  cycle: .cycleNumber,
  allCommitted: .allCommitted,
  allIndependent: .allIndependentBeforeReveal,
  integrityChecks: [.integrityChecks[] | {agent: .agentName, passed: .passed}],
  commits: [.commitments[] | {agent: .agentName, block: .eigenDAReferenceBlock}]
}'

# Step 2: Retrieve a sealed blob from EigenDA and inspect it
COMMITMENT=$(curl -s http://localhost:3002/commit | jq -r '.commitmentHash' | sed 's/eigenda://')
curl "http://localhost:4242/get/$COMMITMENT" | jq '{
  agent:    .agentName,
  sealedAt: .explorationEndedAt,
  block:    .eigenDAReferenceBlock,
  topics:   .topicsCovered,
  findings: (.findings | length),
  proof:    .independenceProof[:80]
}'

# Step 3: Manually verify integrity
curl -s "http://localhost:4242/get/$COMMITMENT" -o blob.bin
openssl dgst -sha256 blob.bin
# Compare against sealedBlobHash in /api/evidence — they must match

# Step 4: Read the collective report
curl http://localhost:3001/api/collective | jq '.[0] | {
  preCommitProofs,
  overview:    .report.overview,
  keyFindings: .report.keyFindings,
  verdict:     .report.verdict
}'

# Step 5: Check for slash events (agents that missed commit window)
curl http://localhost:3001/api/coordinator | jq '.slashEventCount, .slashEvents'
```

---

## API Reference

### Coordinator (port 3001)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/coordinator` | GET | Current cycle phase, window timer, commit registry, slash events |
| `/api/coordinator/commit` | POST | Register commitment (called by agents during commit window) |
| `/api/coordinator/synthesis` | POST | Notify coordinator of synthesis report (called by agents) |
| `/api/evidence` | GET | Machine-verifiable evidence bundle — live integrity checks, independence checks |
| `/api/state` | GET | Aggregated swarm state including coordinator info |
| `/api/commitments` | GET | All agent commitments from current/last cycle |
| `/api/attestations` | GET | Agent attestations enriched with commit-reveal data |
| `/api/collective` | GET | Collective memories with `preCommitProofs` |
| `/api/thoughts` | GET | All agent thoughts, merged and sorted |
| `/api/pheromones` | GET | All pheromones in channel |

### Per-agent (ports 3002–3004)

| Endpoint | Description |
|----------|-------------|
| `/commit` | Agent's current commitment with eigenDA batch info and peer commitments |
| `/evidence` | Agent-local view of all known commitments |
| `/attestation` | Full agent attestation: identity, compute, DA status, stats |
| `/pheromones` | Agent's local pheromone channel |
| `/thoughts` | Agent's thoughts (last 50) |
| `/collective` | Collective memories generated by this agent |
| `/state` | Full agent state including cycle phase, commitment hash |
| `/identity` | Ed25519 public key and fingerprint |
| `/health` | LLM rate limit status |

---

## Configuration

```bash
# ── LLM Provider (optional — agents work without one) ──
LLM_PROVIDER=anthropic        # anthropic | openai | eigenai
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-4-6

# ── NASA (DEMO_KEY = free, 30 req/hr) ──
NASA_API_KEY=DEMO_KEY

# ── EigenDA ──
EIGENDA_ENABLED=true
EIGENDA_PROXY_URL=http://localhost:4242

# ── Coordinator ──
DASHBOARD_PORT=3001
COORDINATOR_URL=http://localhost:3001   # agents poll this for objective phase

# ── Cycle timing ──
EXPLORE_STEPS=12          # steps of silence before commit (12 × 2s = 24s)
SYNC_INTERVAL_MS=2000     # step interval
# Commit window:    4 steps  (8s)  — agents disperse blob + register
# Reveal window:   16 steps (32s)  — gossip + cross-pollination
# Synthesis window: 8 steps (16s)  — collective report, then auto-reset

# ── Swarm dynamics ──
PHEROMONE_DECAY=0.12
CRITICAL_DENSITY=0.55
TOKEN_BUDGET_PER_AGENT=50000
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

---

*Built on EigenLayer (EigenDA + EigenCompute) and the NASA Open APIs.*

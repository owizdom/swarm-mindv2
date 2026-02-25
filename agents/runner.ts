/**
 * Swarm Mind — Single Agent Runner
 *
 * Each agent is its own independent process with:
 *   - Its own SQLite database (no shared state)
 *   - Its own Ed25519 keypair (cryptographic identity)
 *   - Its own HTTP server (peers discover pheromones via polling)
 *   - Its own step loop (no orchestrator tells it what to do)
 *
 * Pheromone propagation is pure gossip:
 *   - Agent emits → POSTs to all peer URLs
 *   - Agent polls peers every tick to absorb their pheromones
 *   - Phase transition detected LOCALLY by each agent independently
 *
 * On EigenCompute: this container runs inside a TEE. The keypair is
 * hardware-generated inside the enclave. The TDX attestation quote
 * proves exactly what code ran and binds it to this agent's public key.
 */

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { SwarmAgent } from "./agent";
import { initDatabase, saveAgent, savePheromone, saveThought, saveCommitment, saveCollectiveMemory, closeDatabase } from "./persistence";
import { initThinker, getTotalTokensUsed, generateCollectiveReport, getLLMUsage } from "./thinker";
import { isEnabled as eigenDAEnabled, disperseBlob } from "./eigenda";
import { verifyAttestation, buildAttestation } from "./keystore";
import type { Pheromone, PheromoneChannel, LLMConfig, CollectiveMemory, SealedBlob, AgentCommitment, CyclePhase, FindingSummary } from "./types";
import { v4 as uuid } from "uuid";
import { hash } from "./types";
import crypto from "crypto";

// ── Config from environment ──
const AGENT_INDEX      = parseInt(process.env.AGENT_INDEX  || "0");
const AGENT_PORT       = parseInt(process.env.AGENT_PORT   || String(3001 + AGENT_INDEX));
const PEER_URLS        = (process.env.PEER_URLS || "").split(",").filter(Boolean);
const DB_PATH          = process.env.DB_PATH || path.join(process.cwd(), `swarm-agent-${AGENT_INDEX}.db`);
const STEP_INTERVAL    = parseInt(process.env.SYNC_INTERVAL_MS || "2000");
const PHEROMONE_DECAY  = parseFloat(process.env.PHEROMONE_DECAY || "0.12");
const CRITICAL_DENSITY = parseFloat(process.env.CRITICAL_DENSITY || "0.55");
const TOKEN_BUDGET     = parseInt(process.env.TOKEN_BUDGET_PER_AGENT || "500000");
const EXPLORE_STEPS    = parseInt(process.env.EXPLORE_STEPS || "20");
// Coordinator URL — dashboard server acts as the objective phase coordinator.
// Agents poll this for phase instead of computing density locally.
const COORDINATOR_URL  = process.env.COORDINATOR_URL || "";

// ── Init ──
initDatabase(DB_PATH);

function initLLM(): boolean {
  const provider = (process.env.LLM_PROVIDER || "eigenai") as LLMConfig["provider"];
  let config: LLMConfig;

  switch (provider) {
    case "anthropic":
      config = { provider: "anthropic", apiUrl: "", apiKey: process.env.ANTHROPIC_API_KEY || "", model: process.env.ANTHROPIC_MODEL || "claude-opus-4-6" };
      break;
    case "openai":
      config = { provider: "openai", apiUrl: process.env.OPENAI_API_URL || "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY || "", model: process.env.OPENAI_MODEL || "gpt-4o" };
      break;
    default:
      config = { provider: "eigenai", apiUrl: process.env.EIGENAI_API_URL || "https://api.eigenai.xyz/v1", apiKey: process.env.EIGENAI_API_KEY || "", model: process.env.EIGENAI_MODEL || "gpt-oss-120b-f16" };
  }

  if (!config.apiKey) return false;
  try { initThinker(config); return true; } catch { return false; }
}

const llmReady = initLLM();
const agent = new SwarmAgent(AGENT_INDEX);
if (llmReady) agent.enableEngineering();

// ── Local pheromone channel ──
const channel: PheromoneChannel = {
  pheromones: [],
  density: 0,
  criticalThreshold: CRITICAL_DENSITY,
  phaseTransitionOccurred: false,
  transitionStep: null,
  cyclePhase: "explore",
  phaseStartStep: 0,
};

let step = 0;
let cycleResetAt = 0;         // timestamp of last cycle reset — pheromones older than this are ignored
let noTransitionBeforeStep = 0; // prevents immediate re-transition right after reset
const collectiveMemories: CollectiveMemory[] = [];

// ── Commit-Reveal state ──
let cyclePhase: CyclePhase = "explore";
let phaseStartStep = 0;
let explorePhaseEndStep = EXPLORE_STEPS;
const agentCommitments = new Map<string, AgentCommitment>();
const explorePheromones: Pheromone[] = [];
let synthesisFiredThisCycle = false;  // prevents double-firing synthesis per cycle
let lastCoordPhase: CyclePhase = "explore"; // tracks last known coordinator phase

// ── Collective report generation (triggered at phase transition) ──
async function generateCollectiveMemory(
  preCommitProofs: Record<string, string>  // agentId → commitmentHash
): Promise<unknown> {
  try {
    const agentThoughts = agent.state.thoughts.slice(-15).map(t => ({
      agentName:      agent.state.name,
      specialization: agent.state.specialization,
      observation:    t.observation,
      reasoning:      t.reasoning,
      conclusion:     t.conclusion,
      confidence:     t.confidence,
    }));

    // Include peer pheromone content as proxy for other agents' findings
    const peerThoughts = channel.pheromones
      .filter(p => p.agentId !== agent.state.id && p.strength > 0.25)
      .slice(0, 10)
      .map(p => ({
        agentName:      p.agentId.slice(0, 8),
        specialization: p.domain,
        observation:    p.content.slice(0, 120),
        reasoning:      "",
        conclusion:     p.content,
        confidence:     p.confidence,
      }));

    const allThoughts = [...agentThoughts, ...peerThoughts];
    const datasets = agent.state.reposStudied.length > 0
      ? agent.state.reposStudied
      : channel.pheromones.map(p => p.domain).filter((d, i, a) => a.indexOf(d) === i);

    if (allThoughts.length === 0) return;

    let { report, tokensUsed } = await generateCollectiveReport(
      allThoughts,
      datasets,
      "NASA Science Collective Intelligence"
    );

    // If the LLM was rate-limited, it returns only the fallback topic as overview
    // Wait and retry once to give Groq quota time to recover
    if (!report.keyFindings.length && !report.verdict) {
      console.log(`  [${agent.state.name}] Collective report rate-limited — retrying in 15s`);
      await new Promise(r => setTimeout(r, 15_000));
      const retry = await generateCollectiveReport(allThoughts, datasets, "NASA Science Collective Intelligence");
      if (retry.report.keyFindings.length > 0) {
        report = retry.report;
        tokensUsed += retry.tokensUsed;
      }
    }

    agent.state.tokensUsed += tokensUsed;

    const synthesis = [
      report.overview,
      "",
      "Key Findings:",
      ...report.keyFindings.map(f => `• ${f}`),
      "",
      report.opinions,
    ].join("\n");

    const memory: CollectiveMemory = {
      id:            uuid(),
      topic:         "NASA Science Collective",
      synthesis,
      contributors:  [agent.state.id],
      pheromoneIds:  channel.pheromones.map(p => p.id),
      confidence:    0.85,
      attestation:   hash(report.overview + report.verdict),
      createdAt:     Date.now(),
      report,
      preCommitProofs,
    };

    collectiveMemories.push(memory);
    try { saveCollectiveMemory(memory); } catch {}
    console.log(`  [${agent.state.name}] Collective memory generated — ${report.keyFindings.length} findings`);
    return report;
  } catch (err) {
    console.error(`  [${agent.state.name}] Collective report error:`, err);
    return null;
  }
}

// ── Coordinator polling ──────────────────────────────────────────────────

interface CoordState {
  phase: CyclePhase;
  cycleId: string;
  cycleNumber: number;
  windowRemainingMs: number;
  commitCount: number;
}

async function pollCoordinator(): Promise<CoordState | null> {
  if (!COORDINATOR_URL) return null;
  try {
    const res = await fetch(`${COORDINATOR_URL}/api/coordinator`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return await res.json() as CoordState;
  } catch {
    return null;
  }
}

async function registerCommitWithCoordinator(commitment: AgentCommitment, eigenDABatchId: string | null, eigenDAReferenceBlock: number | null): Promise<void> {
  if (!COORDINATOR_URL) return;
  try {
    await fetch(`${COORDINATOR_URL}/api/coordinator/commit`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        agentId:              commitment.agentId,
        agentName:            commitment.agentName,
        kzgHash:              commitment.commitmentHash,
        eigenDABatchId,
        eigenDAReferenceBlock,
        sealedBlobHash:       commitment.sealedBlobHash,
        committedViaEigenDA:  commitment.committedViaEigenDA,
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    console.warn(`  [${agent.state.name}] Coordinator commit registration failed: ${err instanceof Error ? err.message.slice(0, 60) : String(err)}`);
  }
}

async function notifySynthesis(report: unknown): Promise<void> {
  if (!COORDINATOR_URL) return;
  try {
    await fetch(`${COORDINATOR_URL}/api/coordinator/synthesis`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ report }),
      signal:  AbortSignal.timeout(2000),
    });
  } catch { /* non-critical */ }
}

// ── Commit phase: seal findings to EigenDA ──
async function performCommit(): Promise<void> {
  const now = Date.now();
  const findings: FindingSummary[] = explorePheromones.map(p => ({
    pheromoneId: p.id,
    contentHash: crypto.createHash("sha256").update(p.content).digest("hex"),
    domain: p.domain,
    confidence: p.confidence,
    timestamp: p.timestamp,
  }));

  // Build independence proof using eigenDA reference block as objective timestamp
  const contentHashes = findings.map(f => f.contentHash).sort();
  const hashesDigest = crypto.createHash("sha256").update(contentHashes.join("|")).digest("hex");

  let commitmentHash: string;
  let committedViaEigenDA = false;
  let eigenDABatchId: string | null = null;
  let eigenDAReferenceBlock: number | null = null;

  if (eigenDAEnabled()) {
    try {
      // Step 1: Disperse a tiny probe blob to get the objective Ethereum reference block
      const probe = await disperseBlob({ agentId: agent.state.id, probe: true, ts: now });
      eigenDAReferenceBlock = probe.referenceBlockNumber;
      eigenDABatchId        = probe.batchId;

      // Step 2: Build independence proof using the reference block as objective timestamp
      const sigPayload = `${agent.state.id}|${eigenDAReferenceBlock}|${hashesDigest}`;
      const independenceProof = buildAttestation(
        sigPayload, agent.state.id, now,
        agent.getPrivateKey(), agent.state.identity.publicKey
      );

      // Step 3: Disperse the FULL sealed blob (with proof) so sha256(fetched blob) is verifiable
      const sealedBlobForDA: SealedBlob = {
        agentId:              agent.state.id,
        agentPublicKey:       agent.state.identity.publicKey,
        agentName:            agent.state.name,
        explorationEndedAt:   now,
        eigenDAReferenceBlock,
        eigenDABatchId,
        teeInstanceId:        process.env.EIGENCOMPUTE_INSTANCE_ID || "local",
        findings,
        topicsCovered:        [...new Set(findings.map(f => f.domain))],
        independenceProof,
      };
      const result = await disperseBlob(sealedBlobForDA);
      commitmentHash      = `eigenda:${result.commitment}`;
      committedViaEigenDA = true;
      // Keep probe's batchId/block so sealedBlob below matches what's stored in EigenDA exactly
      console.log(`  [${agent.state.name}] COMMIT → EigenDA block ${eigenDAReferenceBlock} (${findings.length} findings, integrity-verifiable)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [${agent.state.name}] EigenDA commit failed (${msg.slice(0,60)}), using SHA-256 fallback`);
      eigenDAReferenceBlock = Math.floor(now / 12_000);
      eigenDABatchId = crypto.createHash("sha256").update(`${agent.state.id}${Math.floor(now / 60_000)}`).digest("hex").slice(0, 32);
      commitmentHash = ""; // set below after sealedBlob is built
    }
  } else {
    eigenDAReferenceBlock = Math.floor(now / 12_000);
    eigenDABatchId = crypto.createHash("sha256").update(`${agent.state.id}${Math.floor(now / 60_000)}`).digest("hex").slice(0, 32);
    commitmentHash = ""; // set below after sealedBlob is built
  }

  // Independence proof (used in both EigenDA and SHA-256 paths)
  const sigPayload = `${agent.state.id}|${eigenDAReferenceBlock ?? now}|${hashesDigest}`;
  const independenceProof = buildAttestation(
    sigPayload, agent.state.id, now,
    agent.getPrivateKey(), agent.state.identity.publicKey
  );

  const sealedBlob: SealedBlob = {
    agentId:              agent.state.id,
    agentPublicKey:       agent.state.identity.publicKey,
    agentName:            agent.state.name,
    explorationEndedAt:   now,
    eigenDAReferenceBlock,
    eigenDABatchId,
    teeInstanceId:        process.env.EIGENCOMPUTE_INSTANCE_ID || "local",
    findings,
    topicsCovered:        [...new Set(findings.map(f => f.domain))],
    independenceProof,
  };
  const sealedBlobHash = crypto.createHash("sha256").update(JSON.stringify(sealedBlob)).digest("hex");

  // SHA-256 fallback: commitment = sha256 of the blob (no external DA)
  if (!committedViaEigenDA) {
    commitmentHash = `sha256:${sealedBlobHash}`;
    console.log(`  [${agent.state.name}] COMMIT → SHA-256 block~${eigenDAReferenceBlock}: ${sealedBlobHash.slice(0, 24)}…`);
  }

  agent.state.commitmentHash  = commitmentHash;
  agent.state.commitTimestamp = now;

  const ownCommitment: AgentCommitment = {
    agentId:              agent.state.id,
    agentName:            agent.state.name,
    agentPublicKey:       agent.state.identity.publicKey,
    commitmentHash,
    committedViaEigenDA,
    sealedBlobHash,
    committedAt:          now,
    cycleStartStep:       phaseStartStep,
    eigenDABatchId,
    eigenDAReferenceBlock,
  };
  agentCommitments.set(agent.state.id, ownCommitment);
  try { saveCommitment(ownCommitment); } catch {}

  // Register with coordinator (objective record) + broadcast to peers (gossip fallback)
  await registerCommitWithCoordinator(ownCommitment, eigenDABatchId, eigenDAReferenceBlock);
  await Promise.allSettled(
    PEER_URLS.map(url => fetch(`${url}/commit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body:   JSON.stringify(ownCommitment), signal: AbortSignal.timeout(3000),
    }))
  );

  // Advance to reveal
  cyclePhase             = "reveal";
  channel.cyclePhase     = "reveal";
  phaseStartStep         = step;
  console.log(`  [${agent.state.name}] Phase → REVEAL (step ${step}, eigenDA block ~${eigenDAReferenceBlock})`);
}

// ── Gossip: push to peers ──
async function pushToPeers(pheromone: Pheromone): Promise<void> {
  await Promise.allSettled(
    PEER_URLS.map(url =>
      fetch(`${url}/pheromone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pheromone),
        signal: AbortSignal.timeout(3000),
      })
    )
  );
}

// ── Gossip: pull from peers ──
async function pullFromPeers(): Promise<void> {
  const results = await Promise.allSettled(
    PEER_URLS.map(url =>
      fetch(`${url}/pheromones`, { signal: AbortSignal.timeout(3000) })
        .then(r => r.json() as Promise<Pheromone[]>)
    )
  );

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const p of r.value) {
      // Ignore pheromones created before the last cycle reset — they belong to the old cycle
      if (!channel.pheromones.find(e => e.id === p.id) && p.timestamp > cycleResetAt) {
        channel.pheromones.push(p);
      }
    }
  }
}

// ── Density ──
function updateDensity(): void {
  const active = channel.pheromones.filter(p => p.strength > 0.1);
  const avgStr = active.length ? active.reduce((s, p) => s + p.strength, 0) / active.length : 0;
  channel.density = Math.min(1, (active.length / 24) * avgStr * 1.5);
}

// ── HTTP server ──
const app = express();
app.use(cors());
app.use(express.json());

let dashboardDir = path.join(process.cwd(), "dashboard");
if (!fs.existsSync(path.join(dashboardDir, "index.html"))) {
  dashboardDir = path.join(process.cwd(), "..", "dashboard");
  if (!fs.existsSync(path.join(dashboardDir, "index.html"))) {
    dashboardDir = path.join(__dirname, "..", "..", "dashboard");
  }
}
app.use(express.static(dashboardDir));

const buildAttestationPayload = () => {
  const latest = agent.state.knowledge.slice(-1)[0] || agent.state.thoughts.slice(-1)[0];
  return {
    agent: {
      id:          agent.state.id,
      name:        agent.state.name,
      publicKey:   agent.state.identity.publicKey,
      fingerprint: agent.state.identity.fingerprint,
    },
    compute: {
      eigenCompute: process.env.EIGENCOMPUTE_INSTANCE_ID || "local",
      teeMode:      !!process.env.EIGENCOMPUTE_INSTANCE_ID,
      instanceType: process.env.EIGENCOMPUTE_INSTANCE_TYPE || "local",
    },
    dataAvailability: {
      eigenDAEnabled: eigenDAEnabled(),
      proxyUrl:       process.env.EIGENDA_PROXY_URL || null,
    },
    latestPheromone: latest ? {
      id:          latest.id,
      domain:      latest.domain,
      content:     latest.content.slice(0, 200),
      attestation: latest.attestation,
      eigenda:     latest.eigendaCommitment || null,
      verified:    latest.agentPubkey
        ? verifyAttestation(latest.attestation, latest.content, latest.agentId, latest.timestamp).valid
        : latest.attestation?.startsWith("ed25519:"),
    } : null,
    stats: {
      discoveriesTotal:    agent.state.discoveries,
      pheromonesInChannel: channel.pheromones.length,
      thoughtsFormed:      agent.state.thoughts.length,
      tokensUsed:          agent.state.tokensUsed,
      synchronized:        agent.state.synchronized,
    },
    cycle: {
      phase:               cyclePhase,
      commitmentHash:      agent.state.commitmentHash || null,
      committedViaEigenDA: agentCommitments.get(agent.state.id)?.committedViaEigenDA ?? false,
      knownCommitments:    agentCommitments.size,
    },
    timestamp: Date.now(),
  };
};

const dashboardIndex = path.join(dashboardDir, "index.html");
app.get("/", (_req, res) => res.sendFile(dashboardIndex));
app.get(["/dashboard", "/dashboard/"], (_req, res) => res.sendFile(dashboardIndex));

app.get("/api/state", (_req, res) => {
  res.json({
    step,
    startedAt: Date.now(),
    totalPRs: 0,
    totalTokens: agent.state.tokensUsed,
    transitionStep: null,
    phaseTransitionOccurred: channel.phaseTransitionOccurred,
    metrics: {
      totalPheromones: channel.pheromones.length,
      totalDiscoveries: agent.state.discoveries,
      totalSyncs: agent.state.synchronized ? 1 : 0,
      avgEnergy: agent.state.energy,
      density: channel.density,
      synchronizedCount: agent.state.synchronized ? 1 : 0,
      collectiveMemoryCount: collectiveMemories.length,
      uniqueDomainsExplored: new Set(channel.pheromones.map((p) => p.domain)).size,
    },
    eigenDA: {
      enabled: eigenDAEnabled(),
      attestedPheromones: channel.pheromones.filter((p) => p.eigendaCommitment).length,
      attestedCollectiveMemories: collectiveMemories.filter((m) => !!m.attestation).length,
    },
  });
});

app.get("/api/agents", (_req, res) => {
  res.json([
    {
      id: agent.state.id,
      name: agent.state.name,
      position: agent.state.position,
      velocity: agent.state.velocity,
      energy: agent.state.energy,
      synchronized: agent.state.synchronized,
      explorationTarget: agent.state.explorationTarget,
      discoveries: agent.state.discoveries,
      absorbed: agent.state.absorbed.size,
      knowledgeCount: agent.state.knowledge.length,
      contributionsToCollective: agent.state.contributionsToCollective,
      stepCount: agent.state.stepCount,
      currentAction: agent.state.currentAction || "idle",
      specialization: agent.state.specialization,
      thoughtCount: agent.state.thoughts.length,
      decisionCount: agent.state.decisions.length,
      prsCreated: agent.state.prsCreated.length,
      tokensUsed: agent.state.tokensUsed,
      tokenBudget: agent.state.tokenBudget,
      latestThought: agent.state.thoughts.length > 0 ? agent.state.thoughts[agent.state.thoughts.length - 1]?.conclusion : null,
      phaseTransitionOccurred: channel.phaseTransitionOccurred,
      transitionStep: null,
      criticalThreshold: channel.criticalThreshold,
      density: channel.density,
      cyclePhase,
      commitmentHash: agent.state.commitmentHash ?? null,
    },
  ]);
});

app.get("/api/thoughts", (_req, res) => {
  res.json(agent.state.thoughts.slice(-50).reverse());
});

app.get("/api/decisions", (_req, res) => {
  res.json(agent.state.decisions.slice(-50).reverse());
});

app.get("/api/repos", (_req, res) => {
  const seen = new Set<string>();
  const datasets: Array<{ topic: string; timeRange: string; studiedBy: string[] }> = [];
  for (const entry of agent.state.reposStudied) {
    const [topic, ...rest] = entry.split(":");
    const label = topic.replace(/_/g, " ");
    if (!seen.has(entry)) {
      seen.add(entry);
      datasets.push({ topic: label, timeRange: rest.join(":") || "recent", studiedBy: [agent.state.name] });
    }
  }
  res.json(datasets);
});

app.get("/api/attestations", (_req, res) => {
  res.json([buildAttestationPayload()]);
});

app.get("/api/identities", (_req, res) => {
  res.json([agent.state.identity]);
});

app.get("/api/report", (_req, res) => {
  res.json({
    generatedAt: Date.now(),
    swarmStep: step,
    agentSummaries: [
      {
        name: agent.state.name,
        specialization: agent.state.specialization,
        thoughtCount: agent.state.thoughts.length,
        topConclusions: agent.state.thoughts
          .filter((t) => t.confidence > 0.5)
          .slice(0, 5)
          .map((t) => ({ conclusion: t.conclusion, confidence: t.confidence })),
      },
    ],
    topInsights: agent.state.thoughts
      .slice(-10)
      .filter((t) => t.confidence > 0.5)
      .reverse()
      .map((t) => ({ agentName: agent.state.name, trigger: t.trigger, confidence: t.confidence, conclusion: t.conclusion, reasoning: t.reasoning, suggestedActions: t.suggestedActions })),
    reposStudied: agent.state.reposStudied.map((entry) => {
      const [topic, ...rest] = entry.split(":");
      return {
        topic: topic.replace(/_/g, " "),
        timeRange: rest.join(":") || "recent",
        studiedBy: [agent.state.name],
      };
    }),
    collectiveMemories,
  });
});

app.get("/state", (_, res) => {
  const thoughts = agent.state.thoughts;
  res.json({
    ...agent.state,
    absorbed:       agent.state.absorbed.size,
    thoughtCount:   thoughts.length,
    latestThought:  thoughts.length > 0 ? (thoughts[thoughts.length - 1]?.conclusion ?? null) : null,
    knowledgeCount: agent.state.knowledge.length,
    step,
    eigenDAEnabled: eigenDAEnabled(),
    peerCount:      PEER_URLS.length,
    llmReady,
    density:                  channel.density,
    criticalThreshold:        channel.criticalThreshold,
    phaseTransitionOccurred:  channel.phaseTransitionOccurred,
    cyclePhase,
    commitmentHash:   agent.state.commitmentHash ?? null,
    phaseStartStep,
  });
});

app.get("/pheromones", (_, res) => {
  res.json(channel.pheromones);
});

app.get("/thoughts", (_, res) => {
  res.json(agent.state.thoughts.slice(-50).reverse());
});

app.get("/identity", (_, res) => {
  res.json({
    agentId:     agent.state.id,
    name:        agent.state.name,
    publicKey:   agent.state.identity.publicKey,
    fingerprint: agent.state.identity.fingerprint,
    createdAt:   agent.state.identity.createdAt,
    eigenCompute: process.env.EIGENCOMPUTE_INSTANCE_ID || "local",
    teeMode:     !!process.env.EIGENCOMPUTE_INSTANCE_ID,
  });
});

app.get("/attestation", (_, res) => {
  // Returns verifiable proof of this agent's identity and latest output
  const latest = agent.state.knowledge.slice(-1)[0];
  const proof: Record<string, unknown> = {
    agent: {
      id:          agent.state.id,
      name:        agent.state.name,
      publicKey:   agent.state.identity.publicKey,
      fingerprint: agent.state.identity.fingerprint,
    },
    compute: {
      eigenCompute: process.env.EIGENCOMPUTE_INSTANCE_ID || "local",
      teeMode:      !!process.env.EIGENCOMPUTE_INSTANCE_ID,
      instanceType: process.env.EIGENCOMPUTE_INSTANCE_TYPE || "local",
    },
    dataAvailability: {
      eigenDAEnabled: eigenDAEnabled(),
      proxyUrl:       process.env.EIGENDA_PROXY_URL || null,
    },
    latestPheromone: latest ? {
      id:          latest.id,
      domain:      latest.domain,
      content:     latest.content.slice(0, 200),
      attestation: latest.attestation,
      eigenda:     latest.eigendaCommitment || null,
      verified:    latest.agentPubkey
        ? verifyAttestation(latest.attestation, latest.content, latest.agentId, latest.timestamp).valid
        : false,
    } : null,
    stats: {
      discoveriesTotal:    agent.state.discoveries,
      pheromonesInChannel: channel.pheromones.length,
      thoughtsFormed:      agent.state.thoughts.length,
      tokensUsed:          agent.state.tokensUsed,
      synchronized:        agent.state.synchronized,
    },
    timestamp: Date.now(),
  };
  res.json(proof);
});

app.get("/collective", (_, res) => {
  res.json(collectiveMemories);
});

// Receive pheromone pushed by a peer
app.post("/pheromone", (req, res) => {
  const p = req.body as Pheromone;
  // Reject pheromones from the previous cycle (created before last reset)
  if (p?.id && !channel.pheromones.find(e => e.id === p.id) && p.timestamp > cycleResetAt) {
    channel.pheromones.push(p);
  }
  res.json({ ok: true });
});

app.get("/health", (_, res) => res.json({ ok: true, agent: agent.state.name, step, llm: getLLMUsage() }));

// GET /commit — exposes this agent's current commitment
app.get("/commit", (_, res) => {
  if (!agent.state.commitmentHash) { res.status(204).end(); return; }
  const own = agentCommitments.get(agent.state.id);
  res.json({
    agentId:              agent.state.id,
    agentName:            agent.state.name,
    agentPublicKey:       agent.state.identity.publicKey,
    commitmentHash:       agent.state.commitmentHash,
    committedAt:          agent.state.commitTimestamp,
    cyclePhase,
    committedViaEigenDA:  own?.committedViaEigenDA  ?? false,
    sealedBlobHash:       own?.sealedBlobHash       ?? null,
    eigenDABatchId:       own?.eigenDABatchId        ?? null,
    eigenDAReferenceBlock: own?.eigenDAReferenceBlock ?? null,
    knownPeerCommitments: Object.fromEntries(
      [...agentCommitments.entries()]
        .filter(([id]) => id !== agent.state.id)
        .map(([id, c]) => [id, {
          commitmentHash:      c.commitmentHash,
          eigenDABatchId:      c.eigenDABatchId ?? null,
          eigenDAReferenceBlock: c.eigenDAReferenceBlock ?? null,
        }])
    ),
  });
});

// GET /evidence — agent-local evidence bundle (coordinator has the authoritative one)
app.get("/evidence", (_, res) => {
  const commits = [...agentCommitments.values()];
  const proxyUrl = process.env.EIGENDA_PROXY_URL || null;
  res.json({
    agentId:    agent.state.id,
    agentName:  agent.state.name,
    cyclePhase,
    commitments: commits.map(c => ({
      agentId:              c.agentId,
      agentName:            c.agentName,
      kzgHash:              c.commitmentHash,
      eigenDABatchId:       c.eigenDABatchId ?? null,
      eigenDAReferenceBlock: c.eigenDAReferenceBlock ?? null,
      committedViaEigenDA:  c.committedViaEigenDA,
      sealedBlobHash:       c.sealedBlobHash,
      submittedAt:          c.committedAt,
      verificationUrl:      proxyUrl && c.committedViaEigenDA
        ? `${proxyUrl}/get/${c.commitmentHash.replace("eigenda:", "")}`
        : null,
    })),
    coordinatorUrl: COORDINATOR_URL || null,
  });
});

// POST /commit — receives peer commitment during their commit phase
app.post("/commit", (req, res) => {
  const c = req.body as AgentCommitment;
  if (!c?.agentId || !c?.commitmentHash) { res.status(400).json({ error: "invalid" }); return; }
  if (!agentCommitments.has(c.agentId)) {
    agentCommitments.set(c.agentId, c);
    try { saveCommitment(c); } catch {}
    console.log(`  [${agent.state.name}] Peer commit received: ${c.agentName} → ${c.commitmentHash.slice(0, 24)}…`);
  }
  res.json({ ok: true });
});

app.listen(AGENT_PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  SWARM MIND — ${agent.state.name.padEnd(12)} [${agent.state.specialization}]${" ".repeat(Math.max(0, 5 - agent.state.specialization.length))} ║`);
  console.log(`╠══════════════════════════════════════════════╣`);
  console.log(`║  Port:        ${String(AGENT_PORT).padEnd(30)} ║`);
  console.log(`║  Identity:    ${agent.state.identity.fingerprint.padEnd(30)} ║`);
  console.log(`║  Peers:       ${String(PEER_URLS.length).padEnd(30)} ║`);
  console.log(`║  EigenDA:     ${String(eigenDAEnabled()).padEnd(30)} ║`);
  console.log(`║  LLM:         ${String(llmReady).padEnd(30)} ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
});

// ── Cycle reset helper ──
function resetCycle(): void {
  cycleResetAt              = Date.now();
  noTransitionBeforeStep    = step + EXPLORE_STEPS * 2;
  channel.pheromones        = [];
  channel.density           = 0;
  agent.state.synchronized  = false;
  agent.state.syncedWith    = [];
  agent.state.absorbed      = new Set();
  agent.state.energy        = 0.3 + Math.random() * 0.2;
  agentCommitments.clear();
  explorePheromones.length  = 0;
  agent.state.commitmentHash  = undefined;
  agent.state.commitTimestamp = undefined;
  cyclePhase                = "explore";
  phaseStartStep            = step;
  explorePhaseEndStep       = step + EXPLORE_STEPS;
  channel.cyclePhase        = "explore";
  channel.phaseStartStep    = step;
  synthesisFiredThisCycle   = false;
  lastCoordPhase            = "explore";
  channel.phaseTransitionOccurred = true;
  channel.transitionStep    = step;
  setTimeout(() => {
    channel.phaseTransitionOccurred = false;
    channel.transitionStep = null;
  }, 5000);
}

// ── Main agent loop ──
async function run(): Promise<void> {
  while (true) {
    step++;

    // ── Coordinator-driven phase management ──────────────────────────────
    // Poll coordinator for the objective current phase. If coordinator is
    // unavailable, fall back to local step counter + density detection.
    const coordState = await pollCoordinator();

    if (coordState) {
      const coordPhase = coordState.phase as CyclePhase;

      // Coordinator phase changed — react accordingly
      if (coordPhase !== lastCoordPhase) {
        console.log(`  [${agent.state.name}] Coordinator: ${lastCoordPhase} → ${coordPhase} (cycle ${coordState.cycleNumber})`);
        lastCoordPhase = coordPhase;

        if (coordPhase === "commit" && cyclePhase === "explore") {
          // Coordinator opened the commit window — seal our findings
          cyclePhase         = "commit";
          channel.cyclePhase = "commit";
          await performCommit(); // → sets cyclePhase = "reveal"

        } else if (coordPhase === "reveal" && cyclePhase !== "reveal") {
          // Coordinator opened reveal window — start gossiping
          cyclePhase         = "reveal";
          channel.cyclePhase = "reveal";

        } else if (coordPhase === "synthesis" && !synthesisFiredThisCycle) {
          // Coordinator opened synthesis window — generate collective memory
          synthesisFiredThisCycle = true;
          console.log(`\n${"█".repeat(50)}`);
          console.log(`█  [${agent.state.name}] SYNTHESIS — coordinator cycle ${coordState.cycleNumber}`);
          console.log(`█  Commits: ${coordState.commitCount} | Pheromones: ${channel.pheromones.length}`);
          console.log(`${"█".repeat(50)}\n`);

          const proofSnapshot = Object.fromEntries(
            [...agentCommitments.entries()].map(([id, c]) => [id, c.commitmentHash])
          );
          generateCollectiveMemory(proofSnapshot)
            .then(report => notifySynthesis(report))
            .catch(() => {});

        } else if (coordPhase === "explore" && cyclePhase !== "explore") {
          // Coordinator reset to explore — new cycle begins
          resetCycle();
        }
      }
    } else {
      // ── Fallback: local phase management when coordinator unreachable ──
      // Commit trigger: fire once when explore window ends
      if (cyclePhase === "explore" && step >= explorePhaseEndStep) {
        cyclePhase         = "commit";
        channel.cyclePhase = "commit";
        await performCommit();
      }

      // Synthesis trigger: density threshold during reveal phase
      if (cyclePhase === "reveal" && !synthesisFiredThisCycle && step >= noTransitionBeforeStep) {
        const synced = channel.pheromones.filter(p => p.strength > 0.4).length;
        if (channel.density >= channel.criticalThreshold && synced >= 3) {
          synthesisFiredThisCycle = true;
          console.log(`\n${"█".repeat(50)}`);
          console.log(`█  [${agent.state.name}] PHASE TRANSITION (local fallback) — step ${step}`);
          console.log(`█  Density: ${channel.density.toFixed(3)} | Pheromones: ${channel.pheromones.length}`);
          console.log(`${"█".repeat(50)}\n`);

          const proofSnapshot = Object.fromEntries(
            [...agentCommitments.entries()].map(([id, c]) => [id, c.commitmentHash])
          );
          generateCollectiveMemory(proofSnapshot).catch(() => {});
          resetCycle();
        }
      }
    }
    // ── End phase management ─────────────────────────────────────────────

    // Pull pheromones from peers — only during reveal phase (silence during explore)
    if (cyclePhase === "reveal") {
      await pullFromPeers();
    }

    // Decay
    for (const p of channel.pheromones) p.strength *= (1 - PHEROMONE_DECAY);
    channel.pheromones = channel.pheromones.filter(p => p.strength > 0.05);

    // Update density (display metric — no longer controls phase)
    updateDensity();

    // Agent step
    const pheromone = await agent.step(channel);

    // Emit based on current phase
    if (pheromone) {
      if (cyclePhase === "explore") {
        // Blind exploration — accumulate locally, no gossip
        channel.pheromones.push(pheromone);
        explorePheromones.push(pheromone);
        try { savePheromone(pheromone); } catch { /* db not ready */ }
        console.log(`  [${agent.state.name}] [explore] → ${pheromone.domain} (key:${pheromone.agentPubkey?.slice(0, 8) ?? "sha256"})`);
      } else if (cyclePhase === "reveal") {
        // Reveal phase — stamp with commit proof and gossip
        pheromone.preCommitRef = agent.state.commitmentHash;
        channel.pheromones.push(pheromone);
        try { savePheromone(pheromone); } catch { /* db not ready */ }
        await pushToPeers(pheromone);
        console.log(`  [${agent.state.name}] [reveal] emitted → ${pheromone.domain} (key:${pheromone.agentPubkey?.slice(0, 8) ?? "sha256"})`);
      }
      // commit phase: drop pheromone — commit step produces no gossip
    }

    // Persist agent state periodically
    if (step % 10 === 0) {
      try { saveAgent(agent.state); } catch { /* db not ready */ }
    }

    await new Promise(r => setTimeout(r, STEP_INTERVAL));
  }
}

// Graceful shutdown
process.on("SIGINT",  () => { try { saveAgent(agent.state); closeDatabase(); } catch {} process.exit(0); });
process.on("SIGTERM", () => { try { saveAgent(agent.state); closeDatabase(); } catch {} process.exit(0); });

run().catch(err => { console.error("Fatal:", err); process.exit(1); });

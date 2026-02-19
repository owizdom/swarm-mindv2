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
import { initDatabase, saveAgent, savePheromone, saveThought, closeDatabase } from "./persistence";
import { initThinker, getTotalTokensUsed, generateCollectiveReport } from "./thinker";
import { isEnabled as eigenDAEnabled } from "./eigenda";
import { verifyAttestation } from "./keystore";
import type { Pheromone, PheromoneChannel, LLMConfig, CollectiveMemory } from "./types";
import { v4 as uuid } from "uuid";
import { hash } from "./types";

// ── Config from environment ──
const AGENT_INDEX   = parseInt(process.env.AGENT_INDEX  || "0");
const AGENT_PORT    = parseInt(process.env.AGENT_PORT   || String(3001 + AGENT_INDEX));
const PEER_URLS     = (process.env.PEER_URLS || "").split(",").filter(Boolean);
const DB_PATH       = process.env.DB_PATH || path.join(process.cwd(), `swarm-agent-${AGENT_INDEX}.db`);
const STEP_INTERVAL = parseInt(process.env.SYNC_INTERVAL_MS || "2000");
const PHEROMONE_DECAY = parseFloat(process.env.PHEROMONE_DECAY || "0.12");
const CRITICAL_DENSITY = parseFloat(process.env.CRITICAL_DENSITY || "0.55");
const TOKEN_BUDGET = parseInt(process.env.TOKEN_BUDGET_PER_AGENT || "50000");

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
};

let step = 0;
const collectiveMemories: CollectiveMemory[] = [];

// ── Collective report generation (triggered at phase transition) ──
async function generateCollectiveMemory(): Promise<void> {
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

    const { report, tokensUsed } = await generateCollectiveReport(
      allThoughts,
      datasets,
      "NASA Science Collective Intelligence"
    );

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
    };

    collectiveMemories.push(memory);
    console.log(`  [${agent.state.name}] Collective memory generated — ${report.keyFindings.length} findings`);
  } catch (err) {
    console.error(`  [${agent.state.name}] Collective report error:`, err);
  }
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
      if (!channel.pheromones.find(e => e.id === p.id)) {
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
  if (p?.id && !channel.pheromones.find(e => e.id === p.id)) {
    channel.pheromones.push(p);
  }
  res.json({ ok: true });
});

app.get("/health", (_, res) => res.json({ ok: true, agent: agent.state.name, step }));

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

// ── Main agent loop ──
async function run(): Promise<void> {
  while (true) {
    step++;

    // Pull pheromones from peers (gossip)
    await pullFromPeers();

    // Decay
    for (const p of channel.pheromones) p.strength *= (1 - PHEROMONE_DECAY);
    channel.pheromones = channel.pheromones.filter(p => p.strength > 0.05);

    // Update density locally
    updateDensity();

    // Check phase transition locally (no coordinator needed)
    if (!channel.phaseTransitionOccurred) {
      const synced = channel.pheromones.filter(p => p.strength > 0.4).length;
      if (channel.density >= channel.criticalThreshold && synced >= 3) {
        channel.phaseTransitionOccurred = true;
        channel.transitionStep = step;
        console.log(`\n${"█".repeat(50)}`);
        console.log(`█  [${agent.state.name}] PHASE TRANSITION DETECTED — step ${step}`);
        console.log(`█  Density: ${channel.density.toFixed(3)} | Pheromones: ${channel.pheromones.length}`);
        console.log(`${"█".repeat(50)}\n`);

        // Generate collective memory (fire-and-forget — doesn't block the loop)
        generateCollectiveMemory().catch(() => {});
      }
    }

    // ── Cycle reset: 18 steps after transition, wipe state and start fresh ──
    // This drops density back to 0, un-syncs agents, and lets the swarm rebuild.
    const CYCLE_COOLDOWN = 18;
    if (
      channel.phaseTransitionOccurred &&
      channel.transitionStep !== null &&
      step - channel.transitionStep >= CYCLE_COOLDOWN
    ) {
      console.log(`\n[${agent.state.name}] Cycle reset — new emergence cycle starting\n`);
      channel.pheromones            = [];
      channel.density               = 0;
      channel.phaseTransitionOccurred = false;
      channel.transitionStep        = null;
      agent.state.synchronized      = false;
      agent.state.syncedWith        = [];
      agent.state.absorbed          = new Set();
      agent.state.energy            = 0.3 + Math.random() * 0.2;
    }

    // Agent step
    const pheromone = await agent.step(channel);

    // Emit and gossip
    if (pheromone) {
      channel.pheromones.push(pheromone);
      try { savePheromone(pheromone); } catch { /* db not ready */ }
      await pushToPeers(pheromone);
      console.log(`  [${agent.state.name}] emitted → ${pheromone.domain} (key:${pheromone.agentPubkey?.slice(0, 8) ?? "sha256"})`);
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

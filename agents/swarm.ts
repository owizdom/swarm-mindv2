import dotenv from "dotenv";
dotenv.config();

import {
  SwarmState,
  PheromoneChannel,
  CollectiveMemory,
  SwarmMetrics,
  Pheromone,
  hash,
  hashObject,
} from "./types";
import { SwarmAgent } from "./agent";
import { startDashboard } from "../dashboard/server";
import { v4 as uuid } from "uuid";

/**
 * EMERGENT SWARM MIND
 *
 * Multiple TEE agents explore independently, drop pheromones
 * (attested knowledge fragments), and absorb each other's signals.
 *
 * Above a critical density threshold — PHASE TRANSITION.
 * Agents spontaneously synchronize. Collective memory emerges.
 * Nobody told them to cooperate. The math predicted when.
 * The TEE proves they weren't faking it.
 *
 * Based on:
 *  - "Emergent Collective Memory in Decentralized Multi-Agent AI Systems" (2512.10166)
 *  - "SwarmSys: Decentralized Swarm-Inspired Agents" (2510.10047)
 *  - Phase transition theory in multi-agent systems (2508.08473)
 */

const SWARM_SIZE = parseInt(process.env.SWARM_SIZE || "6");
const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL_MS || "2000");
const PHEROMONE_DECAY = parseFloat(process.env.PHEROMONE_DECAY || "0.12");
const CRITICAL_DENSITY = parseFloat(process.env.CRITICAL_DENSITY || "0.55");
const MAX_STEPS = 80;

function createChannel(): PheromoneChannel {
  return {
    pheromones: [],
    density: 0,
    criticalThreshold: CRITICAL_DENSITY,
    phaseTransitionOccurred: false,
    transitionStep: null,
  };
}

function computeDensity(channel: PheromoneChannel, agentCount: number): number {
  if (channel.pheromones.length === 0) return 0;

  // Density = (active pheromones * avg strength * connectivity) / theoretical max
  const activePheromones = channel.pheromones.filter((p) => p.strength > 0.1);
  const avgStrength =
    activePheromones.reduce((s, p) => s + p.strength, 0) /
    Math.max(1, activePheromones.length);
  const totalConnections = activePheromones.reduce(
    (s, p) => s + p.connections.length,
    0
  );
  const connectivity =
    totalConnections / Math.max(1, activePheromones.length * agentCount);

  // Sigmoid curve — sharp transition around critical threshold
  const raw =
    (activePheromones.length / (agentCount * 8)) *
    avgStrength *
    (1 + connectivity * 2);
  return Math.min(1.0, raw);
}

function decayPheromones(channel: PheromoneChannel): void {
  for (const p of channel.pheromones) {
    p.strength *= 1 - PHEROMONE_DECAY;
  }
  // Remove dead pheromones
  channel.pheromones = channel.pheromones.filter((p) => p.strength > 0.05);
}

/** Synthesize collective memory when agents synchronize */
function synthesizeCollectiveMemory(
  agents: SwarmAgent[],
  channel: PheromoneChannel
): CollectiveMemory | null {
  const syncedAgents = agents.filter((a) => a.state.synchronized);
  if (syncedAgents.length < 3) return null;

  // Group pheromones by domain
  const domainGroups = new Map<string, Pheromone[]>();
  for (const p of channel.pheromones) {
    if (p.strength < 0.3) continue;
    const existing = domainGroups.get(p.domain) || [];
    existing.push(p);
    domainGroups.set(p.domain, existing);
  }

  // Find the richest domain
  let bestDomain = "";
  let bestCount = 0;
  for (const [domain, pheromones] of domainGroups) {
    if (pheromones.length > bestCount) {
      bestDomain = domain;
      bestCount = pheromones.length;
    }
  }

  if (bestCount < 3) return null;

  const domainPheromones = domainGroups.get(bestDomain)!;
  const contributors = [
    ...new Set(domainPheromones.map((p) => p.agentId)),
  ];

  // Only create collective memory if multiple agents contributed
  if (contributors.length < 2) return null;

  const synthesis = domainPheromones
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5)
    .map((p) => `[${p.confidence.toFixed(2)}] ${p.content}`)
    .join("\n\n");

  const avgConfidence =
    domainPheromones.reduce((s, p) => s + p.confidence, 0) /
    domainPheromones.length;

  const memory: CollectiveMemory = {
    id: uuid(),
    topic: bestDomain,
    synthesis,
    contributors,
    pheromoneIds: domainPheromones.map((p) => p.id),
    confidence: Math.min(1.0, avgConfidence + 0.1 * contributors.length),
    attestation: hash(synthesis + contributors.join(",") + Date.now()),
    createdAt: Date.now(),
  };

  // Mark agents as having contributed
  for (const agent of agents) {
    if (contributors.includes(agent.state.id)) {
      agent.state.contributionsToCollective++;
    }
  }

  return memory;
}

function computeMetrics(
  agents: SwarmAgent[],
  channel: PheromoneChannel,
  memories: CollectiveMemory[]
): SwarmMetrics {
  const domains = new Set(channel.pheromones.map((p) => p.domain));
  return {
    totalPheromones: channel.pheromones.length,
    totalDiscoveries: agents.reduce((s, a) => s + a.state.discoveries, 0),
    totalSyncs: agents.filter((a) => a.state.synchronized).length,
    avgEnergy:
      agents.reduce((s, a) => s + a.state.energy, 0) / agents.length,
    density: channel.density,
    synchronizedCount: agents.filter((a) => a.state.synchronized).length,
    collectiveMemoryCount: memories.length,
    uniqueDomainsExplored: domains.size,
  };
}

async function main() {
  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║          EMERGENT SWARM MIND  v1.0.0              ║");
  console.log("║  No leader. No coordinator. Just emergence.       ║");
  console.log("╚═══════════════════════════════════════════════════╝");
  console.log();

  // Create agents
  const agents: SwarmAgent[] = [];
  for (let i = 0; i < SWARM_SIZE; i++) {
    agents.push(new SwarmAgent(i));
  }

  const channel = createChannel();
  const collectiveMemories: CollectiveMemory[] = [];

  const swarmState: SwarmState = {
    agents: agents.map((a) => a.state),
    channel,
    collectiveMemories,
    step: 0,
    startedAt: Date.now(),
    phaseTransitionOccurred: false,
    transitionStep: null,
    metrics: computeMetrics(agents, channel, collectiveMemories),
  };

  // Start dashboard
  const port = parseInt(process.env.DASHBOARD_PORT || "3000");
  startDashboard(swarmState, agents, port);

  console.log(`Swarm size:          ${SWARM_SIZE} agents`);
  console.log(`Critical density:    ${CRITICAL_DENSITY}`);
  console.log(`Pheromone decay:     ${PHEROMONE_DECAY}`);
  console.log(`Sync interval:       ${SYNC_INTERVAL}ms`);
  console.log(`TEE mode:            ${process.env.MNEMONIC ? "YES" : "LOCAL"}`);
  console.log();
  console.log("Agents:");
  for (const a of agents) {
    console.log(
      `  ${a.state.name} — exploring "${a.state.explorationTarget}"`
    );
  }
  console.log();
  console.log("Watching for phase transition...\n");

  // Main swarm loop
  for (let step = 0; step < MAX_STEPS; step++) {
    swarmState.step = step;

    // Decay existing pheromones
    decayPheromones(channel);

    // Each agent takes a step (in parallel conceptually, sequential here)
    const newPheromones: Pheromone[] = [];
    for (const agent of agents) {
      const pheromone = await agent.step(channel);
      if (pheromone) {
        newPheromones.push(pheromone);
      }
    }

    // Deposit new pheromones to channel
    channel.pheromones.push(...newPheromones);

    // Update density
    channel.density = computeDensity(channel, SWARM_SIZE);

    // Check for phase transition
    const syncCount = agents.filter((a) => a.state.synchronized).length;
    if (!channel.phaseTransitionOccurred && syncCount >= Math.ceil(SWARM_SIZE * 0.5)) {
      channel.phaseTransitionOccurred = true;
      channel.transitionStep = step;
      swarmState.phaseTransitionOccurred = true;
      swarmState.transitionStep = step;

      console.log("\n" + "█".repeat(60));
      console.log("█  PHASE TRANSITION — COLLECTIVE INTELLIGENCE EMERGED  █");
      console.log("█".repeat(60));
      console.log(`  Step:        ${step}`);
      console.log(`  Density:     ${channel.density.toFixed(3)}`);
      console.log(`  Synced:      ${syncCount}/${SWARM_SIZE}`);
      console.log(`  Pheromones:  ${channel.pheromones.length}`);
      console.log("█".repeat(60) + "\n");
    }

    // Synthesize collective memory post-transition
    if (channel.phaseTransitionOccurred && step % 3 === 0) {
      const memory = synthesizeCollectiveMemory(agents, channel);
      if (memory) {
        collectiveMemories.push(memory);
        console.log(
          `  [COLLECTIVE] New shared memory: "${memory.topic}" (${memory.contributors.length} contributors, confidence ${memory.confidence.toFixed(2)})`
        );
      }
    }

    // Update swarm state
    swarmState.agents = agents.map((a) => ({
      ...a.state,
      absorbed: new Set(a.state.absorbed),
    }));
    swarmState.metrics = computeMetrics(agents, channel, collectiveMemories);

    // Status line
    const bar = "░".repeat(20).split("");
    const filled = Math.round(channel.density * 20);
    for (let i = 0; i < filled; i++) bar[i] = "█";
    const densityBar = bar.join("");

    const status = channel.phaseTransitionOccurred ? "SYNCED" : "exploring";
    console.log(
      `  [${String(step).padStart(3)}] density ${densityBar} ${channel.density.toFixed(3)} | ` +
        `pheromones ${String(channel.pheromones.length).padStart(3)} | ` +
        `synced ${syncCount}/${SWARM_SIZE} | ` +
        `discoveries ${agents.reduce((s, a) => s + a.state.discoveries, 0)} | ` +
        `${status}`
    );

    // Wait
    await new Promise((r) => setTimeout(r, SYNC_INTERVAL));
  }

  console.log("\n" + "=".repeat(60));
  console.log("SWARM COMPLETE");
  console.log("=".repeat(60));
  console.log(`  Total steps:             ${MAX_STEPS}`);
  console.log(`  Phase transition at:     step ${swarmState.transitionStep ?? "N/A"}`);
  console.log(`  Total pheromones:        ${channel.pheromones.length}`);
  console.log(`  Collective memories:     ${collectiveMemories.length}`);
  console.log(`  Total discoveries:       ${agents.reduce((s, a) => s + a.state.discoveries, 0)}`);
  console.log(`  Agents synchronized:     ${agents.filter((a) => a.state.synchronized).length}/${SWARM_SIZE}`);
  console.log(
    `  Attestation root:        ${hashObject(swarmState).slice(0, 32)}...`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

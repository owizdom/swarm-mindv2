import crypto from "crypto";

/** A single knowledge fragment discovered by an agent */
export interface Pheromone {
  id: string;
  agentId: string;
  content: string;           // The actual knowledge
  domain: string;            // What area this covers
  confidence: number;        // 0-1 how certain the agent is
  strength: number;          // Decays over time, boosted when others confirm
  connections: string[];     // IDs of related pheromones
  timestamp: number;
  attestation: string;       // SHA-256 hash for verification
}

/** What each agent knows and is doing */
export interface AgentState {
  id: string;
  name: string;
  position: { x: number; y: number };  // Abstract 2D exploration space
  velocity: { dx: number; dy: number };
  knowledge: Pheromone[];               // What this agent has discovered
  absorbed: Set<string>;                // Pheromone IDs it has picked up
  explorationTarget: string;            // Current focus area
  energy: number;                       // Activity level 0-1
  synchronized: boolean;               // Has it joined the collective?
  syncedWith: string[];                // Which agents it's synced with
  stepCount: number;
  discoveries: number;
  contributionsToCollective: number;
}

/** The shared pheromone channel — no central coordinator, just signals */
export interface PheromoneChannel {
  pheromones: Pheromone[];
  density: number;           // Current pheromone density (0-1)
  criticalThreshold: number; // When sync happens
  phaseTransitionOccurred: boolean;
  transitionStep: number | null;
}

/** Collective knowledge that emerges after phase transition */
export interface CollectiveMemory {
  id: string;
  topic: string;
  synthesis: string;         // Merged knowledge from multiple agents
  contributors: string[];    // Which agents contributed
  pheromoneIds: string[];    // Which pheromones were combined
  confidence: number;        // Collective confidence
  attestation: string;       // Hash of the full synthesis
  createdAt: number;
}

/** Full swarm state for dashboard */
export interface SwarmState {
  agents: AgentState[];
  channel: PheromoneChannel;
  collectiveMemories: CollectiveMemory[];
  step: number;
  startedAt: number;
  phaseTransitionOccurred: boolean;
  transitionStep: number | null;
  metrics: SwarmMetrics;
}

export interface SwarmMetrics {
  totalPheromones: number;
  totalDiscoveries: number;
  totalSyncs: number;
  avgEnergy: number;
  density: number;
  synchronizedCount: number;
  collectiveMemoryCount: number;
  uniqueDomainsExplored: number;
}

/** Attestation record for TEE verification */
export interface AttestationRecord {
  agentId: string;
  action: string;
  inputHash: string;
  outputHash: string;
  timestamp: number;
  teeSig: string;
}

export function hash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function hashObject(obj: unknown): string {
  return hash(JSON.stringify(obj));
}

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
  attestation: string;       // Ed25519 sig: "ed25519:<sig>:<pubkey>" or SHA-256 fallback
  agentPubkey?: string;      // Agent's Ed25519 public key (hex) for verification
  eigendaCommitment?: string; // KZG commitment from EigenDA once anchored
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

/** LLM-written collective intelligence report */
export interface CollectiveReport {
  overview: string;          // What was studied and the main theme
  keyFindings: string[];     // Concrete things the swarm learned
  opinions: string;          // The swarm's own opinionated take
  improvements: string[];    // What could have been done better
  verdict: string;           // Final assessment / takeaway
}

/** Collective knowledge that emerges after phase transition */
export interface CollectiveMemory {
  id: string;
  topic: string;
  synthesis: string;         // Raw merged knowledge (fallback)
  contributors: string[];    // Which agents contributed
  pheromoneIds: string[];    // Which pheromones were combined
  confidence: number;        // Collective confidence
  attestation: string;       // Hash of the full synthesis
  createdAt: number;
  report?: CollectiveReport; // LLM-written narrative report
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

// ── Engineering Types (v2) ──

/** LLM provider configuration */
export interface LLMConfig {
  provider: "eigenai" | "openai" | "anthropic";
  apiUrl: string;
  apiKey: string;
  model: string;
}

/** Agent personality traits (each 0-1) */
export interface AgentPersonality {
  curiosity: number;   // How eagerly it explores new repos/topics
  diligence: number;   // How thoroughly it reviews and tests
  boldness: number;    // Willingness to tackle hard issues / submit PRs
  sociability: number; // How much it cross-pollinates with other agents
}

/** A structured thought produced by LLM reasoning */
export interface AgentThought {
  id: string;
  agentId: string;
  trigger: string;         // What prompted this thought
  observation: string;     // What the agent noticed
  reasoning: string;       // Chain of thought
  conclusion: string;      // Final takeaway
  suggestedActions: string[]; // What should be done next
  confidence: number;      // 0-1
  timestamp: number;
}

/** Cost estimate for a decision */
export interface DecisionCost {
  estimatedTokens: number;
  estimatedTimeMs: number;
  riskLevel: "low" | "medium" | "high";
}

/** Result of executing a decision */
export interface DecisionResult {
  success: boolean;
  summary: string;
  artifacts: Artifact[];
  tokensUsed: number;
}

/** A real NASA/science dataset fetched and analyzed by an agent */
export interface ScienceDataset {
  id: string;
  topic: string;           // e.g. "near_earth_objects"
  subtopic: string;        // e.g. "Asteroid Close Approaches"
  source: string;          // e.g. "NASA NeoWs API"
  fetchedAt: number;
  recordCount: number;
  timeRange: string;
  stats: Record<string, unknown>;
  highlights: string[];    // Pre-computed notable findings
  analysisContext: string; // JSON-serialized rich data for LLM reasoning
}

/** Discriminated union of possible agent actions */
export type AgentAction =
  | { type: "analyze_dataset"; topic: string }
  | { type: "share_finding"; finding: string; topic?: string }
  | { type: "correlate_findings"; topics: string[] }
  | { type: "explore_topic"; topic: string };

/** A decision an agent makes about what to do */
export interface AgentDecision {
  id: string;
  agentId: string;
  action: AgentAction;
  priority: number;       // Computed score
  cost: DecisionCost;
  status: "pending" | "executing" | "completed" | "failed";
  result: DecisionResult | null;
  createdAt: number;
  completedAt: number | null;
}


/** Output artifact from agent execution */
export interface Artifact {
  type: "finding" | "analysis" | "correlation";
  content: string;
}

/** Cryptographic identity — generated at startup, hardware-rooted on EigenCompute TEE */
export interface AgentIdentity {
  publicKey: string;   // hex-encoded Ed25519 SPKI
  fingerprint: string; // sha256(pubkey).slice(0,16) — shown in UI
  createdAt: number;
}

/** Extended agent state for autonomous science */
export interface AutonomousAgentState extends AgentState {
  thoughts: AgentThought[];
  decisions: AgentDecision[];
  currentDecision: AgentDecision | null;
  reposStudied: string[];     // Re-used as datasetsAnalyzed (topic strings)
  prsCreated: string[];       // Unused in science mode
  tokensUsed: number;
  tokenBudget: number;
  specialization: string;
  personality: AgentPersonality;
  currentAction: string;
  identity: AgentIdentity;    // Cryptographic identity (TEE keypair on EigenCompute)
}

/** Collaborative project detected among agents */
export interface CollaborativeProject {
  id: string;
  title: string;
  description: string;
  participants: string[];     // Agent IDs
  repos: string[];            // "owner/repo" strings
  status: "proposed" | "active" | "completed";
  createdAt: number;
}

// ── Utility Functions ──

export function hash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function hashObject(obj: unknown): string {
  return hash(JSON.stringify(obj));
}

import { v4 as uuid } from "uuid";
import {
  Pheromone,
  PheromoneChannel,
  AutonomousAgentState,
  AgentPersonality,
  AgentThought,
  AgentDecision,
  ScienceDataset,
  hash,
} from "./types";
import { fetchDataset, getRandomTopic } from "./science";
import { formThought, synthesizeKnowledge } from "./thinker";
import { generateCandidateDecisions, selectDecision, shouldSwitch } from "./decider";
import { executeDecision } from "./executor";
import { saveThought, saveDecision, updateDecisionStatus, savePheromone } from "./persistence";
import { initCredits, earnCredits, spendCredits, creditForFinding } from "./credits";

/**
 * Swarm Science Agent
 *
 * Each agent autonomously fetches real NASA datasets, forms scientific
 * hypotheses, shares findings via pheromones, and collectively builds
 * an emergent picture of space and Earth science.
 */

const SCIENCE_TOPICS = [
  "near_earth_objects",
  "solar_flares",
  "earth_events",
  "exoplanets",
  "mars_weather",
];

const NAMES = ["Kepler", "Hubble", "Voyager"];

const PERSONALITY_PRESETS: Array<{ name: string; personality: AgentPersonality }> = [
  {
    name: "Observer",
    personality: { curiosity: 0.9, diligence: 0.7, boldness: 0.3, sociability: 0.5 },
  },
  {
    name: "Synthesizer",
    personality: { curiosity: 0.6, diligence: 0.5, boldness: 0.4, sociability: 0.95 },
  },
  {
    name: "Analyst",
    personality: { curiosity: 0.5, diligence: 0.9, boldness: 0.7, sociability: 0.4 },
  },
];

function generatePersonality(index: number): { specialization: string; personality: AgentPersonality } {
  const preset = PERSONALITY_PRESETS[index % PERSONALITY_PRESETS.length];
  const perturb = () => (Math.random() - 0.5) * 0.08;
  return {
    specialization: preset.name,
    personality: {
      curiosity: Math.max(0, Math.min(1, preset.personality.curiosity + perturb())),
      diligence: Math.max(0, Math.min(1, preset.personality.diligence + perturb())),
      boldness: Math.max(0, Math.min(1, preset.personality.boldness + perturb())),
      sociability: Math.max(0, Math.min(1, preset.personality.sociability + perturb())),
    },
  };
}

export class SwarmAgent {
  state: AutonomousAgentState;
  private discoveredDatasets: ScienceDataset[] = [];
  private engineeringEnabled: boolean = false;

  constructor(index: number) {
    const angle = (index / 8) * Math.PI * 2;
    const radius = 300 + Math.random() * 200;
    const { specialization, personality } = generatePersonality(index);
    const tokenBudget = parseInt(process.env.TOKEN_BUDGET_PER_AGENT || "50000");

    this.state = {
      id: uuid(),
      name: NAMES[index] || `Agent-${index}`,
      position: {
        x: 500 + Math.cos(angle) * radius,
        y: 400 + Math.sin(angle) * radius,
      },
      velocity: {
        dx: (Math.random() - 0.5) * 8,
        dy: (Math.random() - 0.5) * 8,
      },
      knowledge: [],
      absorbed: new Set(),
      explorationTarget: SCIENCE_TOPICS[index % SCIENCE_TOPICS.length],
      energy: 0.3 + Math.random() * 0.3,
      synchronized: false,
      syncedWith: [],
      stepCount: 0,
      discoveries: 0,
      contributionsToCollective: 0,

      thoughts: [],
      decisions: [],
      currentDecision: null,
      reposStudied: [],   // Used as datasetsAnalyzed
      prsCreated: [],
      tokensUsed: 0,
      tokenBudget,
      specialization,
      personality,
      currentAction: "initializing",
      credits: initCredits(100),
    };
  }

  enableEngineering(): void {
    this.engineeringEnabled = true;
  }

  private shouldDoEngineering(): boolean {
    if (!this.engineeringEnabled) return false;
    if (this.state.tokensUsed >= this.state.tokenBudget) return false;
    // Credit tier gates LLM access
    const tier = this.state.credits.tier;
    if (tier === "critical" || tier === "dead") return false;
    const step = this.state.stepCount;
    const probability = Math.min(0.85, step / 40);
    return Math.random() < probability;
  }

  /** Track tokens used and deduct credits accordingly */
  private trackTokens(tokensUsed: number): void {
    this.state.tokensUsed += tokensUsed;
    this.state.credits = spendCredits(this.state.credits, tokensUsed);
  }

  async step(channel: PheromoneChannel): Promise<Pheromone | null> {
    this.state.stepCount++;
    this.move(channel);
    const absorbed = this.absorbPheromones(channel);

    let discovery: Pheromone | null = null;

    if (this.shouldDoEngineering()) {
      if (this.state.currentDecision?.status === "executing") {
        discovery = await this.continueExecution(absorbed);
      } else {
        discovery = await this.scienceStep(channel, absorbed);
      }
    } else {
      discovery = await this.exploreScience(absorbed);
    }

    this.checkSync(channel);
    return discovery;
  }

  /** Deep science step: think → decide → execute → emit pheromone */
  private async scienceStep(
    channel: PheromoneChannel,
    absorbed: Pheromone[]
  ): Promise<Pheromone | null> {
    this.state.currentAction = "thinking";

    try {
      let thought: AgentThought | null = null;

      if (absorbed.length > 0 && this.state.personality.sociability > 0.4) {
        const { thought: synthThought, tokensUsed } = await synthesizeKnowledge(this.state, absorbed);
        thought = synthThought;
        this.trackTokens(tokensUsed);
      } else {
        const datasetsAnalyzed = this.state.reposStudied.length;
        const { thought: ft, tokensUsed } = await formThought(
          this.state,
          datasetsAnalyzed > 0 ? "dataset_review" : "exploration",
          `I have analyzed ${datasetsAnalyzed} NASA datasets. Currently focused on ${this.state.explorationTarget.replace(/_/g, " ")}.`,
          `Specialization: ${this.state.specialization}, energy: ${this.state.energy.toFixed(2)}`
        );
        thought = ft;
        this.trackTokens(tokensUsed);
      }

      if (thought) {
        this.state.thoughts.push(thought);
        try { saveThought(thought); } catch { /* DB not ready */ }
      }

      // Rotate topic to ensure diverse dataset coverage
      if (Math.random() < 0.3) {
        const topics = SCIENCE_TOPICS;
        this.state.explorationTarget = topics[Math.floor(Math.random() * topics.length)];
      }

      // Generate and select a decision
      this.state.currentAction = "deciding";
      const candidates = generateCandidateDecisions(
        this.state,
        channel,
        this.discoveredDatasets,
        this.state.thoughts.slice(-10)
      );

      const decision = selectDecision(candidates, 0.3);
      if (!decision) {
        this.state.currentAction = "idle";
        return null;
      }

      this.state.currentDecision = decision;
      decision.status = "executing";
      try { saveDecision(decision); } catch { /* DB not ready */ }

      const result = await executeDecision(this.state, decision, this.discoveredDatasets);
      if (result.tokensUsed > 0) this.trackTokens(result.tokensUsed);

      decision.status = result.success ? "completed" : "failed";
      decision.result = result;
      decision.completedAt = Date.now();
      this.state.decisions.push(decision);
      this.state.currentDecision = null;

      try { updateDecisionStatus(decision.id, decision.status, result); } catch { /* DB not ready */ }

      console.log(`  [${this.state.name}] ${decision.action.type}: ${result.summary.slice(0, 90)}`);

      if (result.success && result.artifacts.length > 0) {
        return this.createSciencePheromone(decision, result);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  [${this.state.name}] Science step error: ${message.slice(0, 100)}`);
      this.state.currentAction = "recovering";
    }

    return null;
  }

  private async continueExecution(absorbed: Pheromone[]): Promise<Pheromone | null> {
    const decision = this.state.currentDecision;
    if (!decision) return null;

    if (shouldSwitch(this.state, decision.result)) {
      decision.status = "completed";
      decision.completedAt = Date.now();
      this.state.decisions.push(decision);
      this.state.currentDecision = null;
      return null;
    }

    const result = await executeDecision(this.state, decision, this.discoveredDatasets);
    if (result.tokensUsed > 0) this.trackTokens(result.tokensUsed);
    decision.result = result;

    if (result.success || decision.status !== "executing") {
      decision.status = result.success ? "completed" : "failed";
      decision.completedAt = Date.now();
      this.state.decisions.push(decision);
      this.state.currentDecision = null;

      if (result.success && result.artifacts.length > 0) {
        return this.createSciencePheromone(decision, result);
      }
    }

    return null;
  }

  private createSciencePheromone(
    decision: AgentDecision,
    result: { summary: string; artifacts: Array<{ type: string; content: string }> }
  ): Pheromone {
    const topic = "topic" in decision.action
      ? (decision.action as { topic: string }).topic
      : this.state.explorationTarget;

    const pheromone: Pheromone = {
      id: uuid(),
      agentId: this.state.id,
      content: result.summary,
      domain: topic.replace(/_/g, " "),
      confidence: decision.priority,
      strength: 0.65 + decision.priority * 0.3,
      connections: [],
      timestamp: Date.now(),
      attestation: hash(result.summary + this.state.id + Date.now()),
    };

    this.state.knowledge.push(pheromone);
    this.state.discoveries++;

    // Earn credits for the finding based on confidence
    const { amount, reason: earnReason } = creditForFinding(pheromone.confidence);
    if (amount > 0) {
      this.state.credits = earnCredits(this.state.credits, amount, earnReason);
    }

    // Persist to SQLite + disperse to EigenDA for decentralized attestation
    try { savePheromone(pheromone); } catch { /* DB not ready */ }
    return pheromone;
  }

  /** Light exploration: fetch a NASA dataset and emit a pheromone summary */
  private async exploreScience(absorbed: Pheromone[]): Promise<Pheromone | null> {
    this.state.currentAction = `scanning ${this.state.explorationTarget.replace(/_/g, " ")}`;

    const discoveryChance = this.state.synchronized ? 0.75 : 0.45;
    if (Math.random() > discoveryChance) return null;

    let topic = this.state.explorationTarget;
    let connections: string[] = [];
    let confidence = 0.45 + Math.random() * 0.3;

    // Cross-pollination: pick topic from absorbed pheromone's domain
    if (absorbed.length > 0 && Math.random() < 0.55) {
      const source = absorbed[Math.floor(Math.random() * absorbed.length)];
      connections = [source.id];
      confidence = Math.min(1.0, source.confidence + 0.1);
      topic = source.domain.replace(/\s+/g, "_");
      if (source.strength > 0.6) this.state.explorationTarget = topic;
    }

    try {
      const dataset = await fetchDataset(topic);
      if (!dataset) return null;

      // Cache dataset for later deep analysis
      if (!this.discoveredDatasets.some((d) => d.topic === dataset.topic)) {
        this.discoveredDatasets.push(dataset);
      }

      const highlight = dataset.highlights[Math.floor(Math.random() * dataset.highlights.length)];
      const content = `[${dataset.subtopic}] ${highlight}`;

      console.log(`    ${this.state.name} scanned ${dataset.topic}: ${highlight.slice(0, 60)}`);

      const pheromone: Pheromone = {
        id: uuid(),
        agentId: this.state.id,
        content,
        domain: dataset.topic.replace(/_/g, " "),
        confidence,
        strength: 0.5 + confidence * 0.3,
        connections,
        timestamp: Date.now(),
        attestation: hash(content + this.state.id + Date.now()),
      };

      this.state.knowledge.push(pheromone);
      this.state.discoveries++;
      try { savePheromone(pheromone); } catch { /* DB not ready */ }
      return pheromone;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [${this.state.name}] Explore error: ${msg.slice(0, 80)}`);
      return null;
    }
  }

  private move(channel: PheromoneChannel): void {
    if (this.state.synchronized) {
      const cx = 500, cy = 400;
      this.state.velocity.dx += (cx - this.state.position.x) * 0.05;
      this.state.velocity.dy += (cy - this.state.position.y) * 0.05;
      this.state.velocity.dx += (this.state.position.y - cy) * 0.01;
      this.state.velocity.dy += -(this.state.position.x - cx) * 0.01;
    } else {
      this.state.velocity.dx += (Math.random() - 0.5) * 4;
      this.state.velocity.dy += (Math.random() - 0.5) * 4;
      for (const p of channel.pheromones) {
        if (p.agentId === this.state.id || this.state.absorbed.has(p.id)) continue;
        if (p.strength > 0.5) {
          this.state.velocity.dx += (Math.random() - 0.5) * p.strength * 3;
          this.state.velocity.dy += (Math.random() - 0.5) * p.strength * 3;
        }
      }
    }

    this.state.velocity.dx *= 0.85;
    this.state.velocity.dy *= 0.85;
    this.state.position.x = Math.max(50, Math.min(950, this.state.position.x + this.state.velocity.dx));
    this.state.position.y = Math.max(50, Math.min(750, this.state.position.y + this.state.velocity.dy));
  }

  private absorbPheromones(channel: PheromoneChannel): Pheromone[] {
    const absorbed: Pheromone[] = [];
    for (const p of channel.pheromones) {
      if (p.agentId === this.state.id || this.state.absorbed.has(p.id)) continue;
      if (p.strength > 0.2 && Math.random() < p.strength * 0.6) {
        this.state.absorbed.add(p.id);
        absorbed.push(p);
        this.state.energy = Math.min(1.0, this.state.energy + 0.05);
        p.strength = Math.min(1.0, p.strength + 0.1);
      }
    }
    return absorbed;
  }

  private checkSync(channel: PheromoneChannel): void {
    if (this.state.synchronized) return;
    if (
      channel.density >= channel.criticalThreshold &&
      this.state.absorbed.size >= 3 &&
      this.state.energy > 0.5
    ) {
      this.state.synchronized = true;
      this.state.energy = 1.0;
      console.log(`  [${this.state.name}] SYNCHRONIZED (absorbed ${this.state.absorbed.size} signals)`);
    }
  }
}

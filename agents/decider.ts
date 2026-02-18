import { v4 as uuid } from "uuid";
import type {
  AgentDecision,
  AgentAction,
  AgentThought,
  DecisionCost,
  AutonomousAgentState,
  PheromoneChannel,
  ScienceDataset,
  CollaborativeProject,
  Pheromone,
} from "./types";
import { getRandomTopic, ScienceTopic } from "./science";

const SCIENCE_TOPICS: ScienceTopic[] = [
  "near_earth_objects",
  "solar_flares",
  "earth_events",
  "exoplanets",
  "mars_weather",
];

const ACTION_PRIORITIES: Record<AgentAction["type"], number> = {
  analyze_dataset:    0.95,
  share_finding:      0.85,
  correlate_findings: 0.75,
  explore_topic:      0.60,
};

const TOKEN_ESTIMATES: Record<AgentAction["type"], number> = {
  analyze_dataset:    2500,
  share_finding:      1200,
  correlate_findings: 3500,
  explore_topic:      2000,
};

const TIME_ESTIMATES: Record<AgentAction["type"], number> = {
  analyze_dataset:    12000,
  share_finding:      6000,
  correlate_findings: 18000,
  explore_topic:      10000,
};

export function estimateCost(action: AgentAction): DecisionCost {
  return {
    estimatedTokens: TOKEN_ESTIMATES[action.type] || 2000,
    estimatedTimeMs: TIME_ESTIMATES[action.type] || 10000,
    riskLevel: "low",
  };
}

export function generateCandidateDecisions(
  state: AutonomousAgentState,
  channel: PheromoneChannel,
  datasets: ScienceDataset[],
  thoughts: AgentThought[]
): AgentDecision[] {
  const candidates: AgentDecision[] = [];
  const budgetRemaining = state.tokenBudget - state.tokensUsed;

  // From thoughts — parse suggested actions
  for (const thought of thoughts.slice(-5)) {
    for (const suggestion of thought.suggestedActions) {
      const action = parseSuggestedAction(suggestion, state);
      if (!action) continue;
      const cost = estimateCost(action);
      if (cost.estimatedTokens > budgetRemaining) continue;
      candidates.push(makeDecision(state.id, action, cost));
    }
  }

  // Datasets we haven't analyzed yet
  const analyzedTopics = new Set(
    state.reposStudied.map((r) => r.split(":")[0])
  );
  for (const topic of SCIENCE_TOPICS) {
    if (analyzedTopics.has(topic)) continue;
    const action: AgentAction = { type: "analyze_dataset", topic };
    const cost = estimateCost(action);
    if (cost.estimatedTokens > budgetRemaining) continue;
    candidates.push(makeDecision(state.id, action, cost));
  }

  // Re-analyze datasets that have been analyzed (with fresh data)
  if (datasets.length > 0 && Math.random() < 0.3) {
    const pick = datasets[Math.floor(Math.random() * datasets.length)];
    const action: AgentAction = { type: "analyze_dataset", topic: pick.topic };
    const cost = estimateCost(action);
    if (cost.estimatedTokens <= budgetRemaining) {
      candidates.push(makeDecision(state.id, action, cost));
    }
  }

  // Share finding if we have thoughts
  if (state.thoughts.length > 0 && state.personality.sociability > 0.4 && channel.pheromones.length > 2) {
    const bestThought = [...state.thoughts].sort((a, b) => b.confidence - a.confidence)[0];
    const action: AgentAction = {
      type: "share_finding",
      finding: bestThought.conclusion.slice(0, 80),
      topic: bestThought.trigger.split(":")[1],
    };
    const cost = estimateCost(action);
    if (cost.estimatedTokens <= budgetRemaining) {
      candidates.push(makeDecision(state.id, action, cost));
    }
  }

  // Correlate if we have 2+ datasets
  if (datasets.length >= 2 && state.personality.curiosity > 0.5) {
    const shuffled = [...datasets].sort(() => Math.random() - 0.5);
    const action: AgentAction = {
      type: "correlate_findings",
      topics: [shuffled[0].topic, shuffled[1].topic],
    };
    const cost = estimateCost(action);
    if (cost.estimatedTokens <= budgetRemaining) {
      candidates.push(makeDecision(state.id, action, cost));
    }
  }

  // Fallback: explore random topic
  if (candidates.length === 0) {
    const topic = getRandomTopic();
    const action: AgentAction = { type: "explore_topic", topic };
    const cost = estimateCost(action);
    if (cost.estimatedTokens <= budgetRemaining) {
      candidates.push(makeDecision(state.id, action, cost));
    }
  }

  // Score all
  for (const c of candidates) {
    c.priority = scoreDecision(c, state, channel);
  }

  return candidates.sort((a, b) => b.priority - a.priority);
}

function makeDecision(agentId: string, action: AgentAction, cost: DecisionCost): AgentDecision {
  return {
    id: uuid(),
    agentId,
    action,
    priority: 0,
    cost,
    status: "pending",
    result: null,
    createdAt: Date.now(),
    completedAt: null,
  };
}

export function scoreDecision(
  decision: AgentDecision,
  state: AutonomousAgentState,
  channel: PheromoneChannel
): number {
  const action = decision.action;
  const p = state.personality;

  const base = (ACTION_PRIORITIES[action.type] || 0.5) * 0.25;

  const budgetRemaining = state.tokenBudget - state.tokensUsed;
  const costRatio = decision.cost.estimatedTokens / Math.max(1, budgetRemaining);
  const efficiency = Math.max(0, 1 - costRatio) * 0.25;

  const recentTypes = new Set(state.decisions.slice(-8).map((d) => d.action.type));
  const novelty = recentTypes.has(action.type) ? 0 : 0.15;

  let personalFit = 0;
  if (action.type === "analyze_dataset" || action.type === "explore_topic") personalFit = p.curiosity * 0.15;
  if (action.type === "share_finding") personalFit = p.sociability * 0.15;
  if (action.type === "correlate_findings") personalFit = ((p.curiosity + p.diligence) / 2) * 0.15;


  const swarmBonus = channel.phaseTransitionOccurred && action.type === "correlate_findings" ? 0.10 : 0;

  return base + efficiency + novelty + personalFit + swarmBonus;
}

export function selectDecision(candidates: AgentDecision[], temperature = 0.3): AgentDecision | null {
  if (candidates.length === 0) return null;
  if (temperature === 0) return candidates[0];

  const maxP = Math.max(...candidates.map((c) => c.priority));
  const weights = candidates.map((c) => Math.exp((c.priority - maxP) / temperature));
  const total = weights.reduce((s, w) => s + w, 0);

  let roll = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return candidates[i];
  }
  return candidates[0];
}

export function shouldSwitch(
  state: AutonomousAgentState,
  lastResult: { success: boolean } | null
): boolean {
  if (lastResult?.success) return Math.random() < 0.25;
  if (lastResult && !lastResult.success) return Math.random() < 0.7;
  if (!state.currentDecision) return true;
  if (state.tokensUsed >= state.tokenBudget) return true;
  return false;
}

export function detectCollaborativeOpportunity(
  agents: AutonomousAgentState[],
  channel: PheromoneChannel,
  _pheromones: Pheromone[]
): CollaborativeProject | null {
  const syncedAgents = agents.filter((a) => a.synchronized);
  if (syncedAgents.length < 2) return null;

  // Find agents analyzing the same topic
  const topicAgents = new Map<string, string[]>();
  for (const agent of agents) {
    if (!agent.currentDecision) continue;
    const action = agent.currentDecision.action;
    if ("topic" in action && typeof action.topic === "string") {
      const existing = topicAgents.get(action.topic) || [];
      existing.push(agent.id);
      topicAgents.set(action.topic, existing);
    }
  }

  for (const [topic, agentIds] of topicAgents) {
    if (agentIds.length >= 2) {
      return {
        id: uuid(),
        title: `Joint analysis: ${topic.replace(/_/g, " ")}`,
        description: `${agentIds.length} agents are independently analyzing ${topic} — cross-referencing findings could reveal deeper patterns.`,
        participants: agentIds,
        repos: [topic],
        status: "proposed",
        createdAt: Date.now(),
      };
    }
  }

  const specializations = new Set(syncedAgents.map((a) => a.specialization));
  if (specializations.size >= 2) {
    return {
      id: uuid(),
      title: `Cross-domain correlation: ${[...specializations].slice(0, 2).join(" × ")}`,
      description: `${syncedAgents.length} synced agents with complementary scientific lenses could find cross-dataset correlations.`,
      participants: syncedAgents.map((a) => a.id),
      repos: [],
      status: "proposed",
      createdAt: Date.now(),
    };
  }

  return null;
}

// ── Parse suggested actions from LLM output ──

function parseSuggestedAction(suggestion: string, state: AutonomousAgentState): AgentAction | null {
  const lower = suggestion.toLowerCase();

  if (lower.startsWith("analyze_dataset") || lower.includes("analyze")) {
    const colonIdx = suggestion.indexOf(":");
    const topic = colonIdx >= 0 ? suggestion.slice(colonIdx + 1).trim() : getRandomTopic();
    return { type: "analyze_dataset", topic: normalizeTopic(topic) };
  }

  if (lower.startsWith("share_finding") || lower.includes("share")) {
    const colonIdx = suggestion.indexOf(":");
    const finding = colonIdx >= 0 ? suggestion.slice(colonIdx + 1).trim() : state.explorationTarget;
    return { type: "share_finding", finding };
  }

  if (lower.startsWith("correlate") || lower.includes("correlate")) {
    const colonIdx = suggestion.indexOf(":");
    if (colonIdx >= 0) {
      const topicsStr = suggestion.slice(colonIdx + 1).trim();
      const topics = topicsStr.split(",").map((t) => normalizeTopic(t.trim())).slice(0, 2);
      if (topics.length >= 2) return { type: "correlate_findings", topics };
    }
    // Default: correlate two random topics
    const shuffled = [...SCIENCE_TOPICS].sort(() => Math.random() - 0.5);
    return { type: "correlate_findings", topics: [shuffled[0], shuffled[1]] };
  }

  if (lower.startsWith("explore_topic") || lower.includes("explore")) {
    const colonIdx = suggestion.indexOf(":");
    const topic = colonIdx >= 0 ? suggestion.slice(colonIdx + 1).trim() : getRandomTopic();
    return { type: "explore_topic", topic: normalizeTopic(topic) };
  }

  return null;
}

function normalizeTopic(raw: string): string {
  const t = raw.toLowerCase().replace(/\s+/g, "_");
  if (t.includes("neo") || t.includes("asteroid")) return "near_earth_objects";
  if (t.includes("solar") || t.includes("flare")) return "solar_flares";
  if (t.includes("earth") || t.includes("wildfire") || t.includes("storm")) return "earth_events";
  if (t.includes("exoplanet") || t.includes("planet")) return "exoplanets";
  if (t.includes("mars") || t.includes("weather")) return "mars_weather";
  // Check if it's already a valid topic
  if (SCIENCE_TOPICS.includes(t as ScienceTopic)) return t;
  return getRandomTopic();
}

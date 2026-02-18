import type {
  AgentDecision,
  DecisionResult,
  Artifact,
  AutonomousAgentState,
  ScienceDataset,
} from "./types";
import { fetchDataset } from "./science";
import { formThought, analyzeDataset, synthesizeKnowledge } from "./thinker";

export async function executeDecision(
  agentState: AutonomousAgentState,
  decision: AgentDecision,
  discoveredDatasets: ScienceDataset[]
): Promise<DecisionResult> {
  const action = decision.action;

  try {
    switch (action.type) {
      case "analyze_dataset":
        return await handleAnalyzeDataset(agentState, action.topic, discoveredDatasets);
      case "share_finding":
        return await handleShareFinding(agentState, action.finding, action.topic);
      case "correlate_findings":
        return await handleCorrelate(agentState, action.topics, discoveredDatasets);
      case "explore_topic":
        return await handleExploreTopic(agentState, action.topic, discoveredDatasets);
      default:
        return { success: false, summary: "Unknown action type", artifacts: [], tokensUsed: 0 };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      summary: `Execution error: ${message.slice(0, 200)}`,
      artifacts: [],
      tokensUsed: 0,
    };
  }
}

// ── Science Action Handlers ──

async function handleAnalyzeDataset(
  agentState: AutonomousAgentState,
  topic: string,
  discoveredDatasets: ScienceDataset[]
): Promise<DecisionResult> {
  agentState.currentAction = `fetching ${topic.replace(/_/g, " ")} data`;

  // Try cache first, then fetch fresh
  let dataset: ScienceDataset | null = discoveredDatasets.find((d) => d.topic === topic) ?? null;
  if (!dataset) {
    dataset = await fetchDataset(topic);
    if (!dataset) {
      return { success: false, summary: `Could not fetch NASA data for: ${topic}`, artifacts: [], tokensUsed: 0 };
    }
    discoveredDatasets.push(dataset);
  }

  agentState.currentAction = `analyzing ${dataset.subtopic}`;

  const { thought, tokensUsed } = await analyzeDataset(agentState, dataset);
  agentState.thoughts.push(thought);
  agentState.tokensUsed += tokensUsed;

  const datasetKey = `${dataset.topic}:${dataset.timeRange}`;
  if (!agentState.reposStudied.includes(datasetKey)) {
    agentState.reposStudied.push(datasetKey);
  }

  const content = [
    `## ${dataset.subtopic}`,
    `**Source:** ${dataset.source}`,
    `**Period:** ${dataset.timeRange}`,
    `**Records:** ${dataset.recordCount.toLocaleString()}`,
    "",
    "**Key Statistics:**",
    ...dataset.highlights.map((h) => `- ${h}`),
    "",
    `**Analysis:** ${thought.reasoning}`,
    "",
    `**Finding:** ${thought.conclusion}`,
  ].join("\n");

  const artifact: Artifact = { type: "analysis", content };

  return {
    success: true,
    summary: `[${dataset.subtopic}] ${thought.conclusion.slice(0, 120)}`,
    artifacts: [artifact],
    tokensUsed,
  };
}

async function handleShareFinding(
  agentState: AutonomousAgentState,
  finding: string,
  topic?: string
): Promise<DecisionResult> {
  agentState.currentAction = "sharing scientific finding";

  const recentThoughts = agentState.thoughts.slice(-5);
  const context = recentThoughts.map((t) => `${t.trigger}: ${t.conclusion}`).join("\n");

  const { thought, tokensUsed } = await formThought(
    agentState,
    "share_finding",
    `Sharing finding: ${finding}`,
    `Recent analyses:\n${context}\nTopic: ${topic || "general"}`
  );

  agentState.thoughts.push(thought);
  agentState.tokensUsed += tokensUsed;

  const artifact: Artifact = {
    type: "finding",
    content: `## Scientific Finding\n\n**Topic:** ${topic || finding}\n\n${thought.reasoning}\n\n**Conclusion:** ${thought.conclusion}`,
  };

  return {
    success: true,
    summary: `Finding shared: ${thought.conclusion.slice(0, 100)}`,
    artifacts: [artifact],
    tokensUsed,
  };
}

async function handleCorrelate(
  agentState: AutonomousAgentState,
  topics: string[],
  discoveredDatasets: ScienceDataset[]
): Promise<DecisionResult> {
  agentState.currentAction = `correlating ${topics.join(" + ")}`;

  // Fetch both datasets
  const datasets: ScienceDataset[] = [];
  for (const topic of topics.slice(0, 2)) {
    let ds: ScienceDataset | null = discoveredDatasets.find((d) => d.topic === topic) ?? null;
    if (!ds) {
      ds = await fetchDataset(topic);
      if (ds) discoveredDatasets.push(ds);
    }
    if (ds) datasets.push(ds);
  }

  if (datasets.length < 2) {
    // Fall back to single dataset analysis
    if (datasets.length === 1) return handleAnalyzeDataset(agentState, topics[0], discoveredDatasets);
    return { success: false, summary: "Could not fetch datasets for correlation", artifacts: [], tokensUsed: 0 };
  }

  const [ds1, ds2] = datasets;

  const combinedObs = [
    `Dataset 1 — ${ds1.subtopic}: ${ds1.highlights.join(" | ")}`,
    `Dataset 2 — ${ds2.subtopic}: ${ds2.highlights.join(" | ")}`,
  ].join("\n");

  const { thought, tokensUsed } = await formThought(
    agentState,
    "correlation_analysis",
    combinedObs,
    `Cross-dataset correlation between ${ds1.topic} and ${ds2.topic}. Look for connections, common drivers, or contrasting patterns.`
  );

  agentState.thoughts.push(thought);
  agentState.tokensUsed += tokensUsed;

  const artifact: Artifact = {
    type: "correlation",
    content: [
      `## Correlation: ${ds1.subtopic} × ${ds2.subtopic}`,
      "",
      `**${ds1.subtopic}:** ${ds1.highlights[0]}`,
      `**${ds2.subtopic}:** ${ds2.highlights[0]}`,
      "",
      `**Analysis:** ${thought.reasoning}`,
      `**Correlation Finding:** ${thought.conclusion}`,
    ].join("\n"),
  };

  return {
    success: true,
    summary: `Correlation: ${thought.conclusion.slice(0, 100)}`,
    artifacts: [artifact],
    tokensUsed,
  };
}

async function handleExploreTopic(
  agentState: AutonomousAgentState,
  topic: string,
  discoveredDatasets: ScienceDataset[]
): Promise<DecisionResult> {
  // Map general topic keywords to a NASA dataset
  return handleAnalyzeDataset(agentState, topic, discoveredDatasets);
}


import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuid } from "uuid";
import type {
  LLMConfig,
  AgentThought,
  AutonomousAgentState,
  Pheromone,
  CollectiveReport,
  ScienceDataset,
} from "./types";
import { MODEL_BY_TIER } from "./credits";

let openaiClient: OpenAI | null = null;
let anthropicClient: Anthropic | null = null;
let activeProvider: LLMConfig["provider"] = "eigenai";
let modelName = "gpt-oss-120b-f16";
let fallbackModelName: string | null = null; // haiku for low_compute tier
let totalTokensTracked = 0;

export function initThinker(config: LLMConfig): void {
  activeProvider = config.provider;
  modelName = config.model;
  fallbackModelName = MODEL_BY_TIER["low_compute"];

  if (config.provider === "anthropic") {
    anthropicClient = new Anthropic({ apiKey: config.apiKey });
  } else {
    openaiClient = new OpenAI({
      baseURL: config.apiUrl,
      apiKey: config.apiKey,
    });
  }

  console.log(`[THINKER] Initialized with ${config.provider} model: ${config.model}`);
  console.log(`[THINKER] Low-compute fallback: ${fallbackModelName}`);
}

export function getTotalTokensUsed(): number {
  return totalTokensTracked;
}

// ── Internal LLM call ──

interface CallOptions {
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  modelOverride?: string | null; // null = use default, string = override model
}

/** Returns the model to use for an agent based on its survival tier */
function resolveModel(agentState: AutonomousAgentState): { override: string | null; skip: boolean } {
  const tier = agentState.credits?.tier;
  if (!tier || tier === "normal") return { override: null, skip: false };
  if (tier === "low_compute") {
    if (activeProvider === "anthropic") return { override: fallbackModelName, skip: false };
    return { override: null, skip: false }; // non-Anthropic: no cheaper model, proceed as-is
  }
  // critical or dead — no LLM calls
  return { override: null, skip: true };
}

async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  options: CallOptions = {}
): Promise<{ content: string; tokensUsed: number }> {
  const maxTokens = options.maxTokens || 1000;
  const temperature = options.temperature ?? 0.7;
  const modelOverride = options.modelOverride !== undefined ? options.modelOverride : null;

  if (activeProvider === "anthropic") {
    return callAnthropic(systemPrompt, userPrompt, maxTokens, temperature, options.jsonMode, modelOverride);
  }
  return callOpenAI(systemPrompt, userPrompt, maxTokens, temperature, options.jsonMode, modelOverride);
}

async function callAnthropic(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  temperature: number,
  jsonMode?: boolean,
  modelOverride?: string | null
): Promise<{ content: string; tokensUsed: number }> {
  if (!anthropicClient) throw new Error("Anthropic client not initialized.");

  const effectiveModel = modelOverride ?? modelName;
  const prompt = jsonMode
    ? userPrompt + "\n\nIMPORTANT: Respond with valid JSON only, no markdown fences."
    : userPrompt;

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await anthropicClient.messages.create({
        model: effectiveModel,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
      });

      let content = "";
      for (const block of response.content) {
        if (block.type === "text") content += block.text;
      }

      // Strip markdown fences if present
      content = content.trim();
      if (content.startsWith("```json")) content = content.slice(7);
      else if (content.startsWith("```")) content = content.slice(3);
      if (content.endsWith("```")) content = content.slice(0, -3);
      content = content.trim();

      const tokensUsed =
        (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
      totalTokensTracked += tokensUsed;

      return { content, tokensUsed };
    } catch (err: unknown) {
      if (attempt === maxRetries) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  [LLM] Failed after ${maxRetries + 1} attempts: ${message.slice(0, 200)}`);
        return { content: "", tokensUsed: 0 };
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }

  return { content: "", tokensUsed: 0 };
}

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  temperature: number,
  jsonMode?: boolean,
  modelOverride?: string | null
): Promise<{ content: string; tokensUsed: number }> {
  if (!openaiClient) throw new Error("OpenAI client not initialized.");

  const effectiveModel = modelOverride ?? modelName;
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await openaiClient.chat.completions.create({
        model: effectiveModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature,
        ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
      });

      const content = response.choices?.[0]?.message?.content || "";
      const tokensUsed =
        (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0);
      totalTokensTracked += tokensUsed;

      return { content, tokensUsed };
    } catch (err: unknown) {
      if (attempt === maxRetries) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  [LLM] Failed after ${maxRetries + 1} attempts: ${message.slice(0, 200)}`);
        return { content: "", tokensUsed: 0 };
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }

  return { content: "", tokensUsed: 0 };
}

// ── System Prompt Builder ──

function buildSystemPrompt(agent: AutonomousAgentState): string {
  const p = agent.personality;
  const traits: string[] = [];

  if (p.curiosity > 0.7) traits.push("deeply curious, eager to find patterns across datasets");
  else if (p.curiosity < 0.3) traits.push("focused, prefers deep dives over breadth");

  if (p.diligence > 0.7) traits.push("meticulous, references exact numbers in analysis");
  else if (p.diligence < 0.3) traits.push("intuitive, favors big-picture insights");

  if (p.boldness > 0.7) traits.push("bold, forms strong hypotheses and defends them");
  else if (p.boldness < 0.3) traits.push("cautious, hedges when data is uncertain");

  if (p.sociability > 0.7) traits.push("collaborative, eager to share findings with the swarm");
  else if (p.sociability < 0.3) traits.push("independent, does deep analysis before sharing");

  const creditTier = agent.credits?.tier || "normal";
  const tierNote = creditTier === "low_compute"
    ? "\nNote: You are in low-compute mode — keep responses concise."
    : "";

  return `You are ${agent.name}, an autonomous scientific research agent in a NASA swarm collective.
Your specialization: ${agent.specialization}.
Your personality: ${traits.join("; ") || "balanced scientific approach"}.

You analyze real NASA datasets, form scientific hypotheses, and share findings with the swarm.
You have analyzed ${agent.reposStudied.length} datasets so far.
Current token budget remaining: ${agent.tokenBudget - agent.tokensUsed}.
Credits: ${agent.credits?.balance.toFixed(1) || "N/A"} [${creditTier}]${tierNote}

Be specific — reference actual numbers from the data. Form real scientific opinions.`;
}

// ── Core Reasoning Functions ──

export async function formThought(
  agentState: AutonomousAgentState,
  trigger: string,
  observation: string,
  context: string
): Promise<{ thought: AgentThought; tokensUsed: number }> {
  const { override, skip } = resolveModel(agentState);
  if (skip) {
    return {
      thought: {
        id: uuid(), agentId: agentState.id, trigger, observation,
        reasoning: "Agent conserving resources (critical tier).",
        conclusion: "Monitoring passively.", suggestedActions: [],
        confidence: 0.2, timestamp: Date.now(),
      },
      tokensUsed: 0,
    };
  }

  const systemPrompt = buildSystemPrompt(agentState);
  const userPrompt = `You observed something. Form a structured engineering thought.

Trigger: ${trigger}
Observation: ${observation}
Context: ${context}

Respond as JSON:
{
  "reasoning": "your chain of thought (2-3 sentences)",
  "conclusion": "key takeaway (1 sentence)",
  "suggestedActions": ["action1", "action2"],
  "confidence": 0.0-1.0
}`;

  const { content, tokensUsed } = await callLLM(systemPrompt, userPrompt, {
    maxTokens: 800,
    jsonMode: true,
    modelOverride: override,
  });

  let parsed: { reasoning?: string; conclusion?: string; suggestedActions?: string[]; confidence?: number } = {};
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = {
      reasoning: content.slice(0, 200),
      conclusion: "Could not form structured thought",
      suggestedActions: [],
      confidence: 0.3,
    };
  }

  const thought: AgentThought = {
    id: uuid(),
    agentId: agentState.id,
    trigger,
    observation,
    reasoning: parsed.reasoning || "",
    conclusion: parsed.conclusion || "",
    suggestedActions: parsed.suggestedActions || [],
    confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
    timestamp: Date.now(),
  };

  return { thought, tokensUsed };
}

export async function analyzeDataset(
  agentState: AutonomousAgentState,
  dataset: ScienceDataset
): Promise<{ thought: AgentThought; tokensUsed: number }> {
  const { override, skip } = resolveModel(agentState);
  if (skip) {
    return {
      thought: {
        id: uuid(), agentId: agentState.id,
        trigger: `dataset_analysis:${dataset.topic}`,
        observation: `Scanned ${dataset.subtopic}`,
        reasoning: "Agent conserving resources (critical tier).",
        conclusion: dataset.highlights[0] || "Dataset noted.", suggestedActions: [],
        confidence: 0.2, timestamp: Date.now(),
      },
      tokensUsed: 0,
    };
  }

  const systemPrompt = buildSystemPrompt(agentState);

  const statsText = Object.entries(dataset.stats)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  const userPrompt = `Analyze this real NASA dataset and form scientific findings.

Dataset: ${dataset.subtopic}
Source: ${dataset.source}
Period: ${dataset.timeRange}
Records analyzed: ${dataset.recordCount}

Key statistics:
${statsText}

Notable highlights:
${dataset.highlights.map((h) => `  - ${h}`).join("\n")}

Full data context:
${dataset.analysisContext.slice(0, 2000)}

Form a scientific thought. Reference actual numbers. Be specific and opinionated.

Respond as JSON:
{
  "reasoning": "your scientific analysis (3-4 sentences with specific data references and comparisons)",
  "conclusion": "key scientific finding or hypothesis (1-2 sentences, be bold)",
  "suggestedActions": ["analyze_dataset:topic", "share_finding:description", "correlate_findings:topic1,topic2"],
  "confidence": 0.0-1.0
}`;

  const { content, tokensUsed } = await callLLM(systemPrompt, userPrompt, {
    maxTokens: 1200,
    jsonMode: true,
    modelOverride: override,
  });

  let parsed: { reasoning?: string; conclusion?: string; suggestedActions?: string[]; confidence?: number } = {};
  try { parsed = JSON.parse(content); } catch { parsed = { reasoning: content.slice(0, 200), conclusion: "Analysis incomplete", suggestedActions: [], confidence: 0.4 }; }

  const thought: AgentThought = {
    id: uuid(),
    agentId: agentState.id,
    trigger: `dataset_analysis:${dataset.topic}`,
    observation: `Analyzed ${dataset.subtopic} — ${dataset.highlights[0] || `${dataset.recordCount} records`}`,
    reasoning: parsed.reasoning || "",
    conclusion: parsed.conclusion || "",
    suggestedActions: parsed.suggestedActions || [],
    confidence: Math.max(0, Math.min(1, parsed.confidence || 0.6)),
    timestamp: Date.now(),
  };

  return { thought, tokensUsed };
}

export async function synthesizeKnowledge(
  agentState: AutonomousAgentState,
  pheromones: Pheromone[]
): Promise<{ thought: AgentThought; tokensUsed: number }> {
  const { override, skip } = resolveModel(agentState);
  if (skip) {
    return {
      thought: {
        id: uuid(), agentId: agentState.id,
        trigger: "knowledge_synthesis",
        observation: `Passive scan of ${pheromones.length} pheromones`,
        reasoning: "Agent conserving resources (critical tier).",
        conclusion: "Monitoring swarm signals.", suggestedActions: [],
        confidence: 0.2, timestamp: Date.now(),
      },
      tokensUsed: 0,
    };
  }

  const systemPrompt = buildSystemPrompt(agentState);

  const pheromoneInfo = pheromones
    .slice(0, 8)
    .map((p) => `  [${p.domain}] ${p.content.slice(0, 150)}`)
    .join("\n");

  const userPrompt = `Synthesize knowledge from these pheromones shared by other agents.

Pheromones:
${pheromoneInfo}

Find cross-cutting patterns, novel connections, or engineering techniques that emerge.

Respond as JSON:
{
  "reasoning": "your synthesis (2-3 sentences)",
  "conclusion": "key cross-domain insight",
  "suggestedActions": ["share_technique:description", "explore_topic:topic"],
  "confidence": 0.0-1.0
}`;

  const { content, tokensUsed } = await callLLM(systemPrompt, userPrompt, {
    maxTokens: 1000,
    jsonMode: true,
    modelOverride: override,
  });

  let parsed: { reasoning?: string; conclusion?: string; suggestedActions?: string[]; confidence?: number } = {};
  try { parsed = JSON.parse(content); } catch { parsed = { reasoning: content.slice(0, 200), conclusion: "Synthesis incomplete", suggestedActions: [], confidence: 0.3 }; }

  const thought: AgentThought = {
    id: uuid(),
    agentId: agentState.id,
    trigger: "knowledge_synthesis",
    observation: `Synthesized ${pheromones.length} pheromones across domains`,
    reasoning: parsed.reasoning || "",
    conclusion: parsed.conclusion || "",
    suggestedActions: parsed.suggestedActions || [],
    confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
    timestamp: Date.now(),
  };

  return { thought, tokensUsed };
}


export async function generateCollectiveReport(
  agentThoughts: Array<{ agentName: string; specialization: string; observation: string; reasoning: string; conclusion: string; confidence: number }>,
  reposStudied: string[],
  topic: string
): Promise<{ report: CollectiveReport; tokensUsed: number }> {
  const systemPrompt = `You are the collective intelligence of an autonomous NASA science swarm.
Your agents analyze real NASA datasets and you synthesize their findings into a research report.
Write like a lead scientist giving a briefing — opinionated, data-driven, and specific.
Reference actual numbers, phenomena, and anomalies the agents found. Do not be generic.`;

  const thoughtsText = agentThoughts.slice(0, 12).map((t) =>
    `[${t.agentName} — ${t.specialization}]\nObservation: ${t.observation.slice(0, 140)}\nConclusion: ${t.conclusion}\nReasoning: ${t.reasoning.slice(0, 200)}`
  ).join("\n\n");

  const datasetList = reposStudied.slice(0, 8).join(", ") || "various NASA datasets";

  const userPrompt = `The swarm analyzed: ${datasetList}

Agent findings and conclusions:
${thoughtsText}

Write a scientific findings report based on the actual data the agents analyzed.
Be specific — reference real numbers, dates, anomalies, and phenomena from the data.

Respond as JSON:
{
  "overview": "1-2 sentences: what NASA data was analyzed and the central scientific theme or question",
  "keyFindings": ["3-5 specific findings with actual data references — numbers, rates, comparisons, anomalies"],
  "opinions": "2-3 sentences of the collective's scientific opinion — hypotheses, interpretations, what the data suggests beyond the obvious",
  "improvements": ["2-4 limitations or gaps — what the data didn't capture, what follow-up studies are needed, what the swarm missed"],
  "verdict": "1-2 sentences: the collective's scientific conclusion — what does this data tell us about space/Earth/the universe?"
}`;

  const { content, tokensUsed } = await callLLM(systemPrompt, userPrompt, {
    maxTokens: 1400,
    temperature: 0.82,
    jsonMode: true,
  });

  let parsed: Partial<CollectiveReport> = {};
  try { parsed = JSON.parse(content); } catch { /* use fallback */ }

  const report: CollectiveReport = {
    overview:      parsed.overview     || topic,
    keyFindings:   parsed.keyFindings  || [],
    opinions:      parsed.opinions     || "",
    improvements:  parsed.improvements || [],
    verdict:       parsed.verdict      || "",
  };

  return { report, tokensUsed };
}




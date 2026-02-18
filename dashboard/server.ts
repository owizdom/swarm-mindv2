import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { SwarmState, AgentThought, AgentDecision, CollaborativeProject, Pheromone, hash } from "../agents/types";
import { SwarmAgent } from "../agents/agent";
import { getRecentThoughts, getRecentDecisions, getAgentStats, getRecentPheromones, getCollectiveMemories } from "../agents/persistence";
import { isEnabled as eigenDAEnabled } from "../agents/eigenda";
import { v4 as uuid } from "uuid";

interface EnhancedState {
  globalThoughtStream: AgentThought[];
  globalDecisionLog: AgentDecision[];
  collaborativeProjects: CollaborativeProject[];
}

export function startDashboard(
  state: SwarmState,
  agents: SwarmAgent[],
  port: number,
  enhanced?: EnhancedState
): void {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // From dist/dashboard/server.js: ../../dashboard → project root/dashboard ✓
  // From dashboard/server.ts (dev): ../../dashboard → overshoots ✗, fall back to ../dashboard
  let dashboardDir = path.join(__dirname, "..", "..", "dashboard");
  if (!fs.existsSync(path.join(dashboardDir, "index.html"))) {
    dashboardDir = path.join(__dirname, "..", "dashboard");
  }
  app.use(express.static(dashboardDir));

  app.get("/api/state", (_req, res) => {
    const totalPRs = agents.reduce((s, a) => s + a.state.prsCreated.length, 0);
    const totalTokens = agents.reduce((s, a) => s + a.state.tokensUsed, 0);
    res.json({
      step: state.step,
      startedAt: state.startedAt,
      phaseTransitionOccurred: state.phaseTransitionOccurred,
      transitionStep: state.transitionStep,
      metrics: state.metrics,
      density: state.channel.density,
      criticalThreshold: state.channel.criticalThreshold,
      totalPRs,
      totalTokens,
    });
  });

  app.get("/api/agents", (_req, res) => {
    res.json(
      agents.map((a) => ({
        id: a.state.id,
        name: a.state.name,
        position: a.state.position,
        velocity: a.state.velocity,
        energy: a.state.energy,
        synchronized: a.state.synchronized,
        explorationTarget: a.state.explorationTarget,
        discoveries: a.state.discoveries,
        absorbed: a.state.absorbed.size,
        knowledgeCount: a.state.knowledge.length,
        contributionsToCollective: a.state.contributionsToCollective,
        stepCount: a.state.stepCount,
        // v2 fields
        currentAction: a.state.currentAction || "idle",
        specialization: a.state.specialization,
        thoughtCount: a.state.thoughts.length,
        decisionCount: a.state.decisions.length,
        prsCreated: a.state.prsCreated.length,
        tokensUsed: a.state.tokensUsed,
        tokenBudget: a.state.tokenBudget,
        latestThought: a.state.thoughts.length > 0
          ? a.state.thoughts[a.state.thoughts.length - 1].conclusion
          : null,
        // Conway credit economy
        credits: a.state.credits || { balance: 0, earned: 0, spent: 0, tier: "normal", distressEmitted: false },
      }))
    );
  });

  app.get("/api/pheromones", (_req, res) => {
    res.json(
      state.channel.pheromones.map((p) => ({
        id: p.id,
        agentId: p.agentId,
        content: p.content,
        domain: p.domain,
        confidence: p.confidence,
        strength: p.strength,
        connections: p.connections,
        timestamp: p.timestamp,
        attestation: p.attestation,
        // v2: include pheromoneType if it's an engineering pheromone
        pheromoneType: (p as unknown as Record<string, unknown>).pheromoneType || "knowledge",
      }))
    );
  });

  app.get("/api/collective", (_req, res) => {
    res.json(state.collectiveMemories);
  });

  // ── v2 Endpoints ──

  app.get("/api/thoughts", (_req, res) => {
    if (enhanced) {
      res.json(enhanced.globalThoughtStream.slice(-50).reverse());
    } else {
      try {
        res.json(getRecentThoughts(50));
      } catch {
        res.json([]);
      }
    }
  });

  app.get("/api/decisions", (_req, res) => {
    if (enhanced) {
      res.json(enhanced.globalDecisionLog.slice(-50).reverse());
    } else {
      try {
        res.json(getRecentDecisions(50));
      } catch {
        res.json([]);
      }
    }
  });

  // Returns datasets analyzed by agents (reposStudied repurposed as datasetsAnalyzed)
  app.get("/api/repos", (_req, res) => {
    const seen = new Set<string>();
    const datasets: Array<{ topic: string; timeRange: string; studiedBy: string[] }> = [];
    for (const agent of agents) {
      for (const entry of agent.state.reposStudied) {
        if (!seen.has(entry)) {
          seen.add(entry);
          const [topic, ...rest] = entry.split(":");
          datasets.push({ topic: topic.replace(/_/g, " "), timeRange: rest.join(":") || "recent", studiedBy: [] });
        }
        // Add agent name to studiedBy
        const ds = datasets.find((d) => d.topic === entry.split(":")[0].replace(/_/g, " "));
        if (ds && !ds.studiedBy.includes(agent.state.name)) ds.studiedBy.push(agent.state.name);
      }
    }
    res.json(datasets);
  });

  // Findings shared by agents (prsCreated unused in science mode)
  app.get("/api/prs", (_req, res) => {
    res.json([]);
  });

  app.get("/api/agent/:id", (req, res) => {
    const agent = agents.find((a) => a.state.id === req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    let stats = null;
    try {
      stats = getAgentStats(agent.state.id);
    } catch { /* DB not ready */ }

    res.json({
      ...agent.state,
      absorbed: agent.state.absorbed.size,
      knowledgeCount: agent.state.knowledge.length,
      recentThoughts: agent.state.thoughts.slice(-10),
      recentDecisions: agent.state.decisions.slice(-10),
      stats,
    });
  });

  app.get("/api/collaborations", (_req, res) => {
    res.json(enhanced?.collaborativeProjects || []);
  });

  app.get("/api/report", (_req, res) => {
    const allThoughts = enhanced
      ? enhanced.globalThoughtStream
      : (() => { try { return getRecentThoughts(200); } catch { return []; } })();

    // Per-agent summary
    const agentSummaries = agents.map((a) => ({
      name: a.state.name,
      specialization: a.state.specialization,
      reposStudied: a.state.reposStudied,
      thoughtCount: a.state.thoughts.length,
      decisionsCompleted: a.state.decisions.filter((d) => d.status === "completed").length,
      tokensUsed: a.state.tokensUsed,
      topConclusions: a.state.thoughts
        .filter((t) => t.confidence > 0.5)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5)
        .map((t) => ({ conclusion: t.conclusion, confidence: t.confidence, trigger: t.trigger })),
      latestThought: a.state.thoughts.length > 0
        ? a.state.thoughts[a.state.thoughts.length - 1]
        : null,
    }));

    // Top insights across all agents
    const topInsights = allThoughts
      .filter((t) => t.confidence > 0.6)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 20)
      .map((t) => {
        const agent = agents.find((a) => a.state.id === t.agentId);
        return {
          agentName: agent?.state.name || "Unknown",
          agentColor: agent ? agent.state.specialization : "Generalist",
          trigger: t.trigger,
          conclusion: t.conclusion,
          reasoning: t.reasoning,
          suggestedActions: t.suggestedActions,
          confidence: t.confidence,
          timestamp: t.timestamp,
        };
      });

    // Repos studied across all agents
    const repoSet = new Map<string, { owner: string; repo: string; studiedBy: string[] }>();
    for (const agent of agents) {
      for (const r of agent.state.reposStudied) {
        const existing = repoSet.get(r) || { owner: r.split("/")[0], repo: r.split("/")[1], studiedBy: [] };
        existing.studiedBy.push(agent.state.name);
        repoSet.set(r, existing);
      }
    }

    res.json({
      generatedAt: Date.now(),
      swarmStep: state.step,
      phaseTransition: state.phaseTransitionOccurred,
      agentSummaries,
      topInsights,
      reposStudied: [...repoSet.values()],
      collectiveMemories: state.collectiveMemories,
    });
  });

  // ── EigenDA / Attestation Status ──

  app.get("/api/da-status", (_req, res) => {
    try {
      const pheromones = getRecentPheromones(100);
      const memories = getCollectiveMemories();

      const attestedPheromones = pheromones.filter((p) => p.eigendaCommitment);
      const attestedMemories = memories.filter((m) => m.eigendaCommitment);

      res.json({
        enabled: eigenDAEnabled(),
        proxyUrl: process.env.EIGENDA_PROXY_URL || null,
        pheromones: {
          total: pheromones.length,
          attested: attestedPheromones.length,
          latest: attestedPheromones.slice(0, 5).map((p) => ({
            id: p.id,
            domain: p.domain,
            commitment: p.eigendaCommitment,
            timestamp: p.timestamp,
          })),
        },
        collectiveMemories: {
          total: memories.length,
          attested: attestedMemories.length,
          items: attestedMemories.map((m) => ({
            id: m.id,
            domain: m.domain,
            commitment: m.eigendaCommitment,
            timestamp: m.timestamp,
          })),
        },
      });
    } catch {
      res.json({ enabled: eigenDAEnabled(), proxyUrl: process.env.EIGENDA_PROXY_URL || null, pheromones: { total: 0, attested: 0, latest: [] }, collectiveMemories: { total: 0, attested: 0, items: [] } });
    }
  });

  // ── Conway: Credit & Survival Status ──

  app.get("/api/credits", (_req, res) => {
    res.json(
      agents.map((a) => ({
        agentId: a.state.id,
        agentName: a.state.name,
        specialization: a.state.specialization,
        credits: a.state.credits || { balance: 0, earned: 0, spent: 0, tier: "normal", distressEmitted: false },
        tokensUsed: a.state.tokensUsed,
        tokenBudget: a.state.tokenBudget,
      }))
    );
  });

  // Inject a human pheromone into the swarm channel
  app.post("/api/inject", (req, res) => {
    const { topic, content } = req.body as { topic?: string; content?: string };
    const text = content || `Human injected topic: ${topic}`;
    const pheromone: Pheromone = {
      id: uuid(),
      agentId: "human",
      content: text,
      domain: topic || "injected",
      confidence: 0.85,
      strength: 0.95,
      connections: [],
      timestamp: Date.now(),
      attestation: hash(text + "human" + Date.now()),
    };
    state.channel.pheromones.push(pheromone);
    res.json({ ok: true, pheromone });
  });

  app.get("/", (_req, res) => {
    res.sendFile(path.join(dashboardDir, "index.html"));
  });

  app.listen(port, () => {
    console.log(`[DASHBOARD] http://localhost:${port}\n`);
  });
}

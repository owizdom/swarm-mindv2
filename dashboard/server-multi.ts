/**
 * Dashboard Server — Multi-Agent Mode
 *
 * Reads state from each independent agent HTTP API.
 * No shared database. No central coordinator.
 * If an agent is down, the rest keep working.
 */

import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";

const AGENT_URLS   = (process.env.AGENT_URLS || "http://localhost:3001,http://localhost:3002,http://localhost:3003").split(",").filter(Boolean);
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || "3000");

const app = express();
app.use(cors());
app.use(express.json());

// Serve dashboard HTML
let dashboardDir = path.join(__dirname, "..", "..", "dashboard");
if (!fs.existsSync(path.join(dashboardDir, "index.html"))) {
  dashboardDir = path.join(__dirname, "..", "dashboard");
}
app.use(express.static(dashboardDir));

// ── Aggregate helpers ──

async function fetchAgent(url: string, endpoint: string): Promise<unknown> {
  try {
    const res = await fetch(`${url}${endpoint}`, { signal: AbortSignal.timeout(3000) });
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchAllAgents(endpoint: string): Promise<unknown[]> {
  const results = await Promise.allSettled(AGENT_URLS.map(u => fetchAgent(u, endpoint)));
  return results.map(r => r.status === "fulfilled" ? r.value : null).filter(Boolean);
}

// ── API endpoints ──

app.get("/api/agents", async (_req, res) => {
  const states = await fetchAllAgents("/state") as Array<Record<string, unknown>>;
  // Strip large arrays — dashboard uses pre-computed counts from runner.ts /state
  const reshaped = states.filter(Boolean).map((s) => {
    const { thoughts, decisions, knowledge, personality, currentDecision, ...rest } = s;
    void thoughts; void decisions; void knowledge; void personality; void currentDecision;
    return rest;
  });
  res.json(reshaped);
});

app.get("/api/thoughts", async (_req, res) => {
  const all = await fetchAllAgents("/thoughts");
  const merged = (all.flat() as Array<{ timestamp: number }>)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 50);
  res.json(merged);
});

app.get("/api/pheromones", async (_req, res) => {
  const all = await fetchAllAgents("/pheromones");
  const seen = new Set<string>();
  const merged: unknown[] = [];
  for (const p of all.flat() as Array<{ id: string }>) {
    if (!seen.has(p.id)) { seen.add(p.id); merged.push(p); }
  }
  merged.sort((a: unknown, b: unknown) => ((b as { timestamp: number }).timestamp || 0) - ((a as { timestamp: number }).timestamp || 0));
  res.json(merged.slice(0, 100));
});

app.get("/api/attestations", async (_req, res) => {
  const proofs = await fetchAllAgents("/attestation");
  res.json(proofs);
});

app.get("/api/identities", async (_req, res) => {
  const ids = await fetchAllAgents("/identity");
  res.json(ids);
});

app.get("/api/state", async (_req, res) => {
  const states = await fetchAllAgents("/state") as Array<Record<string, unknown>> | null;
  if (!states || states.length === 0) { res.json({}); return; }

  const validStates = states.filter(Boolean) as Array<Record<string, unknown>>;
  const step             = Math.max(...validStates.map(s => (s.step as number) || 0));
  const totalTokens      = validStates.reduce((s, a) => s + ((a.tokensUsed as number) || 0), 0);
  const synced           = validStates.filter(s => s.synchronized).length;
  const phaseTransition  = validStates.some(s => s.phaseTransitionOccurred);
  const criticalThreshold = (validStates[0]?.criticalThreshold as number) ?? 0.55;
  // Use the density already computed inside each agent (averaged across all agents)
  const density = validStates.reduce((s, a) => s + ((a.density as number) || 0), 0) / Math.max(1, validStates.length);

  // Fetch pheromones just for metrics
  const allPheromones = (await fetchAllAgents("/pheromones")).flat();
  const seen = new Set<string>();
  const unique: unknown[] = [];
  for (const p of allPheromones as Array<{ id: string }>) {
    if (!seen.has(p.id)) { seen.add(p.id); unique.push(p); }
  }

  res.json({
    step,
    totalTokens,
    density,
    criticalThreshold,
    synchronizedCount: synced,
    agentCount: validStates.length,
    phaseTransitionOccurred: phaseTransition,
    metrics: {
      totalPheromones:        unique.length,
      totalDiscoveries:       validStates.reduce((s, a) => s + ((a.discoveries as number) || 0), 0),
      totalSyncs:             synced,
      avgEnergy:              validStates.reduce((s, a) => s + ((a.energy as number) || 0), 0) / Math.max(1, validStates.length),
      density,
      synchronizedCount:      synced,
      collectiveMemoryCount:  0,
      uniqueDomainsExplored:  new Set((unique as Array<{ domain: string }>).map(p => p.domain)).size,
    },
    eigenDA: {
      enabled: validStates.some(s => s.eigenDAEnabled),
      attestedPheromones: (unique as Array<{ eigendaCommitment?: string }>).filter(p => p.eigendaCommitment).length,
    },
  });
});

// Collective memories — collapse reports from the same transition cycle (30s window) into one
app.get("/api/collective", async (_req, res) => {
  const all = await fetchAllAgents("/collective");
  const seen = new Set<string>();
  const memories: Array<{ id: string; createdAt: number }> = [];
  for (const m of all.flat() as Array<{ id: string; createdAt: number }>) {
    if (m?.id && !seen.has(m.id)) { seen.add(m.id); memories.push(m); }
  }
  memories.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  // Group by 30-second windows — agents all fire within a few seconds of each other per transition
  const WINDOW_MS = 30_000;
  const windows = new Map<number, { id: string; createdAt: number }>();
  for (const m of memories) {
    const key = Math.floor((m.createdAt || 0) / WINDOW_MS);
    // Keep the one with most content (most findings) or just the first seen
    if (!windows.has(key)) windows.set(key, m);
  }
  const collapsed = [...windows.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json(collapsed);
});

// Repos/datasets studied
app.get("/api/repos", async (_req, res) => {
  const states = await fetchAllAgents("/state") as Array<Record<string, unknown>>;
  const seen = new Set<string>();
  const datasets: Array<{ topic: string; timeRange: string; studiedBy: string[] }> = [];
  for (const agent of states.filter(Boolean)) {
    for (const entry of (agent.reposStudied as string[]) || []) {
      const [topic, ...rest] = entry.split(":");
      const label = topic.replace(/_/g, " ");
      if (!seen.has(entry)) {
        seen.add(entry);
        datasets.push({ topic: label, timeRange: rest.join(":") || "recent", studiedBy: [] });
      }
      const ds = datasets.find(d => d.topic === label);
      if (ds && !(ds.studiedBy.includes(agent.name as string))) ds.studiedBy.push(agent.name as string);
    }
  }
  res.json(datasets);
});

// Report — aggregates thoughts, datasets, and collective memories for the Report tab
app.get("/api/report", async (_req, res) => {
  const [states, allThoughts, allCollective, repos] = await Promise.all([
    fetchAllAgents("/state") as Promise<Array<Record<string, unknown>>>,
    fetchAllAgents("/thoughts"),
    fetchAllAgents("/collective"),
    fetchAgent(AGENT_URLS[0], "/state").then(() => null).catch(() => null), // warm-up, unused
  ]);

  const validStates = (states as Array<Record<string, unknown>>).filter(Boolean);

  // Top insights: interleave best thoughts from EACH agent so report is truly collective
  type Thought = {
    id: string; agentId: string; agentName?: string; conclusion?: string;
    reasoning?: string; confidence?: number; trigger?: string; suggestedActions?: string[];
  };
  const allFlat = (allThoughts.flat() as Thought[]).filter(t => t.conclusion);

  // Group by agent, sort each group by confidence
  const byAgent = new Map<string, Thought[]>();
  for (const t of allFlat) {
    const key = t.agentName || t.agentId || "unknown";
    if (!byAgent.has(key)) byAgent.set(key, []);
    byAgent.get(key)!.push(t);
  }
  for (const [, arr] of byAgent) arr.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  // Round-robin interleave: take up to 4 from each agent
  const topInsights: object[] = [];
  const agentQueues = [...byAgent.values()];
  const perAgent = 4;
  for (let round = 0; round < perAgent; round++) {
    for (const queue of agentQueues) {
      if (queue[round]) {
        const t = queue[round];
        topInsights.push({
          agentName:        t.agentName || t.agentId?.slice(0, 8),
          trigger:          t.trigger || "analysis",
          confidence:       t.confidence || 0,
          conclusion:       t.conclusion,
          reasoning:        t.reasoning,
          suggestedActions: t.suggestedActions || [],
        });
      }
    }
  }

  // Collective memories (deduplicated)
  const seenMem = new Set<string>();
  const collectiveMemories: unknown[] = [];
  for (const m of allCollective.flat() as Array<{ id: string; createdAt: number }>) {
    if (m?.id && !seenMem.has(m.id)) { seenMem.add(m.id); collectiveMemories.push(m); }
  }
  collectiveMemories.sort((a, b) =>
    ((b as { createdAt: number }).createdAt || 0) - ((a as { createdAt: number }).createdAt || 0)
  );

  // Datasets studied
  const seenDs = new Set<string>();
  const reposStudied: Array<{ topic: string; timeRange: string; studiedBy: string[] }> = [];
  for (const agent of validStates) {
    for (const entry of (agent.reposStudied as string[]) || []) {
      const [topic, ...rest] = entry.split(":");
      const label = topic.replace(/_/g, " ");
      if (!seenDs.has(entry)) {
        seenDs.add(entry);
        reposStudied.push({ topic: label, timeRange: rest.join(":") || "recent", studiedBy: [] });
      }
      const ds = reposStudied.find(d => d.topic === label);
      if (ds && !(ds.studiedBy.includes(agent.name as string))) ds.studiedBy.push(agent.name as string);
    }
  }

  // Per-agent summaries
  const agentSummaries = validStates.map(agent => {
    const agentThoughts = allFlat.filter((t: Thought) => t.agentId === agent.id || t.agentName === agent.name);
    return {
      name:            agent.name,
      specialization:  agent.specialization,
      thoughtCount:    agent.thoughtCount || agentThoughts.length,
      topConclusions:  agentThoughts.slice(0, 3),
    };
  });

  res.json({ topInsights, collectiveMemories, reposStudied, agentSummaries });
});

app.get("/api/prs", (_req, res) => res.json([]));
app.get("/api/decisions", async (_req, res) => res.json([]));

// Inject pheromone — fan out to all agents
app.post("/api/inject", async (req, res) => {
  const { topic, content } = req.body as { topic?: string; content?: string };
  const text = content || `Human injected: ${topic}`;
  await Promise.allSettled(
    AGENT_URLS.map(url =>
      fetch(`${url}/pheromone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: `human-${Date.now()}`,
          agentId: "human",
          content: text,
          domain: topic || "injected",
          confidence: 0.85,
          strength: 0.95,
          connections: [],
          timestamp: Date.now(),
          attestation: "human",
        }),
      })
    )
  );
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(dashboardDir, "index.html"));
});

app.listen(DASHBOARD_PORT, () => {
  console.log(`\n[DASHBOARD] http://localhost:${DASHBOARD_PORT}`);
  console.log(`[DASHBOARD] Aggregating from ${AGENT_URLS.length} independent agents:`);
  AGENT_URLS.forEach(u => console.log(`  → ${u}`));
  console.log();
});

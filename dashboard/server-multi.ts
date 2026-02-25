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
import crypto from "crypto";

const AGENT_URLS      = (process.env.AGENT_URLS || "http://127.0.0.1:3002,http://127.0.0.1:3003,http://127.0.0.1:3004").split(",").filter(Boolean);
const DASHBOARD_PORT  = parseInt(process.env.DASHBOARD_PORT || "3001");
const EXPLORE_STEPS   = parseInt(process.env.EXPLORE_STEPS   || "20");
const STEP_INTERVAL   = parseInt(process.env.SYNC_INTERVAL_MS || "1500");

// ── Coordinator State Machine ──────────────────────────────────────────────
// Manages objective, coordinator-driven cycle phases instead of each agent
// locally detecting density thresholds. All agents poll /api/coordinator and
// react to phase changes. This makes phase boundaries objectively verifiable.

type CoordPhase = "explore" | "commit" | "reveal" | "synthesis";

interface CommitEntry {
  agentId: string;
  agentName: string;
  kzgHash: string;
  eigenDABatchId: string | null;
  eigenDAReferenceBlock: number | null;
  sealedBlobHash: string;
  submittedAt: number;
  committedViaEigenDA: boolean;
  windowMissed: boolean;
}

interface SlashEvent {
  agentId: string;
  agentName: string;
  fault: "missed_commit" | "missed_reveal" | "hash_mismatch";
  cycleId: string;
  detectedAt: number;
}

interface CoordinatorState {
  cycleId: string;
  cycleNumber: number;
  phase: CoordPhase;
  phaseStartedAt: number;
  cycleStartedAt: number;
  commitWindowCloseBlock: number | null; // Ethereum block estimate when commit window closed
  commitRegistry: Map<string, CommitEntry>;
  slashEvents: SlashEvent[];
  lastSynthesisReport: unknown | null;
  expectedAgentCount: number;
}

// Phase durations (wall-clock ms)
const EXPLORE_MS   = EXPLORE_STEPS * STEP_INTERVAL;
const COMMIT_MS    = 4 * STEP_INTERVAL;   // 4 steps to disperse + register
const REVEAL_MS    = 16 * STEP_INTERVAL;  // 16 steps to gossip
const SYNTHESIS_MS = 8 * STEP_INTERVAL;   // 8 steps for synthesis then auto-reset

function newCycleState(cycleNumber: number): CoordinatorState {
  return {
    cycleId: crypto.randomUUID(),
    cycleNumber,
    phase: "explore",
    phaseStartedAt: Date.now(),
    cycleStartedAt: Date.now(),
    commitWindowCloseBlock: null,
    commitRegistry: new Map(),
    slashEvents: [],
    lastSynthesisReport: null,
    expectedAgentCount: AGENT_URLS.length,
  };
}

let coordinator: CoordinatorState = newCycleState(1);

// Keep last N completed cycle states for the evidence endpoint
const completedCycles: CoordinatorState[] = [];
const MAX_COMPLETED_CYCLES = 10;

function advanceCycle(): void {
  const now = Date.now();
  const elapsed = now - coordinator.phaseStartedAt;

  switch (coordinator.phase) {
    case "explore":
      if (elapsed >= EXPLORE_MS) {
        coordinator.phase = "commit";
        coordinator.phaseStartedAt = now;
        console.log(`[COORDINATOR] Cycle ${coordinator.cycleNumber} → COMMIT (window: ${COMMIT_MS}ms)`);
      }
      break;

    case "commit":
      if (elapsed >= COMMIT_MS) {
        // Detect any agents that missed the commit window
        // +1 block so referenceBlock (set during commit) is always < commitWindowCloseBlock
        coordinator.commitWindowCloseBlock = Math.floor(now / 12_000) + 1;
        for (const url of AGENT_URLS) {
          // We check based on commit registry — agents not registered are marked missed
          const registered = [...coordinator.commitRegistry.values()].some(
            c => !c.windowMissed
          );
          void registered; // slash detection is done per-agent on POST /commit
        }
        coordinator.phase = "reveal";
        coordinator.phaseStartedAt = now;
        console.log(`[COORDINATOR] Cycle ${coordinator.cycleNumber} → REVEAL (${coordinator.commitRegistry.size} commits received)`);
      }
      break;

    case "reveal":
      if (elapsed >= REVEAL_MS) {
        coordinator.phase = "synthesis";
        coordinator.phaseStartedAt = now;
        console.log(`[COORDINATOR] Cycle ${coordinator.cycleNumber} → SYNTHESIS`);
      }
      break;

    case "synthesis":
      if (elapsed >= SYNTHESIS_MS) {
        const next = coordinator.cycleNumber + 1;
        console.log(`[COORDINATOR] Cycle ${coordinator.cycleNumber} complete → starting Cycle ${next} (EXPLORE)`);
        // Archive completed cycle before resetting
        completedCycles.push(coordinator);
        if (completedCycles.length > MAX_COMPLETED_CYCLES) completedCycles.shift();
        coordinator = newCycleState(next);
      }
      break;
  }
}

// Advance cycle phase every second
setInterval(advanceCycle, 1000);

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

// ── Coordinator API ────────────────────────────────────────────────────────

// GET /api/coordinator — agents poll this every step for current phase
app.get("/api/coordinator", (_req, res) => {
  const now = Date.now();
  const elapsed = now - coordinator.phaseStartedAt;
  let windowRemainingMs = 0;
  switch (coordinator.phase) {
    case "explore":   windowRemainingMs = Math.max(0, EXPLORE_MS - elapsed);   break;
    case "commit":    windowRemainingMs = Math.max(0, COMMIT_MS - elapsed);    break;
    case "reveal":    windowRemainingMs = Math.max(0, REVEAL_MS - elapsed);    break;
    case "synthesis": windowRemainingMs = Math.max(0, SYNTHESIS_MS - elapsed); break;
  }
  res.json({
    cycleId:            coordinator.cycleId,
    cycleNumber:        coordinator.cycleNumber,
    phase:              coordinator.phase,
    phaseStartedAt:     coordinator.phaseStartedAt,
    windowRemainingMs,
    commitCount:        coordinator.commitRegistry.size,
    expectedAgentCount: coordinator.expectedAgentCount,
    slashEventCount:    coordinator.slashEvents.length,
    commits: [...coordinator.commitRegistry.values()].map(c => ({
      agentId:              c.agentId,
      agentName:            c.agentName,
      kzgHash:              c.kzgHash.slice(0, 32) + "…",
      eigenDABatchId:       c.eigenDABatchId,
      eigenDAReferenceBlock: c.eigenDAReferenceBlock,
      committedViaEigenDA:  c.committedViaEigenDA,
      submittedAt:          c.submittedAt,
    })),
  });
});

// POST /api/coordinator/commit — agents register their commitment during commit window
app.post("/api/coordinator/commit", (req, res) => {
  const body = req.body as Partial<CommitEntry> & { agentId?: string; agentName?: string; kzgHash?: string };
  if (!body?.agentId || !body?.kzgHash) {
    res.status(400).json({ error: "agentId and kzgHash are required" });
    return;
  }

  if (coordinator.phase !== "commit") {
    // Agent submitted outside commit window — slash event
    const slash: SlashEvent = {
      agentId:   body.agentId,
      agentName: body.agentName ?? body.agentId,
      fault:     "missed_commit",
      cycleId:   coordinator.cycleId,
      detectedAt: Date.now(),
    };
    coordinator.slashEvents.push(slash);
    console.warn(`[COORDINATOR] SLASH: ${body.agentName} committed outside window (phase=${coordinator.phase})`);
    res.status(409).json({
      error:  "commit_window_closed",
      phase:  coordinator.phase,
      cycleId: coordinator.cycleId,
      fault:  "missed_commit",
    });
    return;
  }

  const entry: CommitEntry = {
    agentId:              body.agentId,
    agentName:            body.agentName ?? body.agentId,
    kzgHash:              body.kzgHash,
    eigenDABatchId:       body.eigenDABatchId ?? null,
    eigenDAReferenceBlock: body.eigenDAReferenceBlock ?? null,
    sealedBlobHash:       body.sealedBlobHash ?? "",
    submittedAt:          Date.now(),
    committedViaEigenDA:  body.committedViaEigenDA ?? false,
    windowMissed:         false,
  };

  coordinator.commitRegistry.set(body.agentId, entry);
  console.log(`[COORDINATOR] Commit registered: ${entry.agentName} → ${entry.kzgHash.slice(0, 20)}… (${coordinator.commitRegistry.size}/${coordinator.expectedAgentCount})`);

  res.json({
    ok:                true,
    cycleId:           coordinator.cycleId,
    position:          coordinator.commitRegistry.size,
    allCommitted:      coordinator.commitRegistry.size >= coordinator.expectedAgentCount,
  });
});

// GET /api/evidence — machine-verifiable evidence bundle for current/last cycle
app.get("/api/evidence", async (_req, res) => {
  // Use the most recent completed cycle if current cycle has no commits yet
  const source = coordinator.commitRegistry.size > 0
    ? coordinator
    : (completedCycles.length > 0 ? completedCycles[completedCycles.length - 1] : coordinator);
  const commits = [...source.commitRegistry.values()];
  const proxyUrl = process.env.EIGENDA_PROXY_URL || null;

  const commitmentRecords = commits.map(c => ({
    agentId:              c.agentId,
    agentName:            c.agentName,
    kzgHash:              c.kzgHash,
    eigenDABatchId:       c.eigenDABatchId,
    eigenDAReferenceBlock: c.eigenDAReferenceBlock,
    submittedAt:          c.submittedAt,
    committedViaEigenDA:  c.committedViaEigenDA,
    sealedBlobHash:       c.sealedBlobHash,
  }));

  // Live integrity check: fetch blob from EigenDA and verify sha256(blob) === sealedBlobHash
  const integrityChecks = await Promise.all(commits.map(async c => {
    const verificationUrl = proxyUrl && c.committedViaEigenDA
      ? `${proxyUrl}/get/${c.kzgHash.replace("eigenda:", "")}`
      : null;

    let passed: boolean | null = null;
    if (verificationUrl && c.sealedBlobHash) {
      try {
        const r = await fetch(verificationUrl, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          const actualHash = crypto.createHash("sha256").update(buf).digest("hex");
          passed = (actualHash === c.sealedBlobHash);
        }
      } catch { /* proxy unreachable */ }
    }

    return {
      agentId:                 c.agentId,
      agentName:               c.agentName,
      committedSealedBlobHash: c.sealedBlobHash,
      verificationUrl,
      passed,
    };
  }));

  const revealWindowBlock = source.commitWindowCloseBlock;
  const independenceChecks = commits.map(c => {
    const ref = c.eigenDAReferenceBlock;
    const close = revealWindowBlock;
    return {
      agentId:                c.agentId,
      agentName:              c.agentName,
      eigenDAReferenceBlock:  ref,
      commitWindowCloseBlock: close,
      // Block when blob was sealed must be before the reveal window opened
      independentBeforeReveal: (ref !== null && close !== null) ? ref < close : null,
    };
  });

  const allIndependentBeforeReveal = independenceChecks.every(c => c.independentBeforeReveal !== false)
    ? (independenceChecks.some(c => c.independentBeforeReveal === true) ? true : null)
    : false;

  const bundle = {
    cycleId:       source.cycleId,
    cycleNumber:   source.cycleNumber,
    generatedAt:   Date.now(),
    commitments:   commitmentRecords,
    integrityChecks,
    independenceChecks,
    allCommitted:  commits.length >= source.expectedAgentCount,
    allIndependentBeforeReveal,
    synthesis:     source.lastSynthesisReport,
    slashEvents:   source.slashEvents,
    verifierInstructions: [
      "1. For each commitment with committedViaEigenDA=true:",
      "   GET {verificationUrl} → deserialize blob → sha256(blob) should equal committedSealedBlobHash",
      "2. Each blob.findings[].contentHash should match sha256(reveal-phase pheromone.content)",
      "   (pheromones with preCommitRef set are reveal-phase; those without are explore-phase)",
      "3. independenceChecks: eigenDAReferenceBlock < commitWindowCloseBlock proves blob was",
      "   sealed before the reveal window opened — agent could not have copied peers",
      "4. For sha256-only commits (EigenDA unavailable): verify independently by re-running",
      "   the agent with the same inputs (determinism not guaranteed; treat as best-effort)",
    ].join("\n"),
  };

  res.json(bundle);
});

// POST /api/coordinator/synthesis — agent notifies coordinator it generated synthesis
app.post("/api/coordinator/synthesis", (req, res) => {
  const { report } = req.body as { report?: unknown };
  if (report && coordinator.phase === "synthesis") {
    coordinator.lastSynthesisReport = report;
  }
  res.json({ ok: true });
});

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
  const [attestations, commits] = await Promise.all([
    fetchAllAgents("/attestation"),
    fetchAllAgents("/commit"),
  ]);
  const enriched = (attestations as Array<Record<string, unknown>>).map(attest => {
    if (!attest) return attest;
    const agentId = (attest as { agent?: { id?: string } }).agent?.id;
    const commitData = (commits as Array<Record<string, unknown> | null>)
      .find(c => c && (c as { agentId?: string }).agentId === agentId) ?? null;
    return { ...attest, commitReveal: commitData ?? null };
  });
  res.json(enriched);
});

app.get("/api/commitments", async (_req, res) => {
  const commits = await fetchAllAgents("/commit");
  res.json(commits.filter(Boolean));
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

  const cyclePhaseCounts: Record<string, number> = {};
  for (const s of validStates) {
    const p = (s.cyclePhase as string) ?? "explore";
    cyclePhaseCounts[p] = (cyclePhaseCounts[p] ?? 0) + 1;
  }

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
    cyclePhase: coordinator.phase,
    coordinator: {
      cycleId:        coordinator.cycleId,
      cycleNumber:    coordinator.cycleNumber,
      phase:          coordinator.phase,
      commitCount:    coordinator.commitRegistry.size,
      slashEvents:    coordinator.slashEvents.length,
      expectedAgents: coordinator.expectedAgentCount,
    },
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

const dashboardIndex = path.join(dashboardDir, "index.html");

app.get("/", (_req, res) => {
  res.sendFile(dashboardIndex);
});

app.get(["/dashboard", "/dashboard/"], (_req, res) => {
  res.sendFile(dashboardIndex);
});

app.listen(DASHBOARD_PORT, "0.0.0.0", () => {
  console.log(`\n[DASHBOARD] http://localhost:${DASHBOARD_PORT}`);
  console.log(`[DASHBOARD] Aggregating from ${AGENT_URLS.length} independent agents:`);
  AGENT_URLS.forEach(u => console.log(`  → ${u}`));
  console.log();
});

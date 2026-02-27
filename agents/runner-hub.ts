/**
 * Swarm Mind — Hub Dashboard Runner
 *
 * This process runs on the central "Swarm Mind" EigenCloud instance.
 * It does NOT run any agent logic — it polls all 3 agent instances
 * (Kepler, Hubble, Voyager), aggregates their state, and serves a
 * unified dashboard at port 80.
 *
 * Env:
 *   PEER_URLS=http://kepler,http://hubble,http://voyager   (required)
 *   AGENT_PORT=80                                          (optional)
 *   SYNC_INTERVAL_MS=5000                                  (poll cadence)
 */

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";

const HUB_PORT  = parseInt(process.env.AGENT_PORT || "80");
const PEER_URLS = (process.env.PEER_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const POLL_MS   = parseInt(process.env.SYNC_INTERVAL_MS || "5000");

// ── Per-peer cached state ─────────────────────────────────────────────────

interface PeerState {
  url:          string;
  name:         string;
  state:        Record<string, unknown> | null;
  agents:       unknown[];
  pheromones:   unknown[];
  thoughts:     unknown[];
  collective:   unknown[];
  attestations: unknown[];
  commitments:  unknown[];
  repos:        unknown[];
  lastFetched:  number;
  online:       boolean;
  error:        string | null;
}

const peers: PeerState[] = PEER_URLS.map(url => ({
  url,
  name:         url,
  state:        null,
  agents:       [],
  pheromones:   [],
  thoughts:     [],
  collective:   [],
  attestations: [],
  commitments:  [],
  repos:        [],
  lastFetched:  0,
  online:       false,
  error:        null,
}));

async function safeJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return fallback;
    return await r.json() as T;
  } catch {
    return fallback;
  }
}

async function pollPeer(peer: PeerState): Promise<void> {
  const [state, agents, pheromones, thoughts, collective, attestations, commitments, repos] =
    await Promise.all([
      safeJson<Record<string, unknown> | null>(`${peer.url}/api/state`,       null),
      safeJson<unknown[]>(`${peer.url}/api/agents`,       []),
      safeJson<unknown[]>(`${peer.url}/api/pheromones`,   []),
      safeJson<unknown[]>(`${peer.url}/api/thoughts`,     []),
      safeJson<unknown[]>(`${peer.url}/api/collective`,   []),
      safeJson<unknown[]>(`${peer.url}/api/attestations`, []),
      safeJson<unknown[]>(`${peer.url}/api/commitments`,  []),
      safeJson<unknown[]>(`${peer.url}/api/repos`,        []),
    ]);

  peer.state        = state;
  peer.agents       = agents;
  peer.pheromones   = pheromones;
  peer.thoughts     = thoughts;
  peer.collective   = collective;
  peer.attestations = attestations;
  peer.commitments  = commitments;
  peer.repos        = repos;
  peer.lastFetched  = Date.now();
  peer.online       = !!state;
  peer.error        = peer.online ? null : `No response from ${peer.url}`;

  // Label with agent name once discovered
  const firstAgent = agents[0] as { name?: string } | undefined;
  if (firstAgent?.name) peer.name = firstAgent.name;
}

async function pollLoop(): Promise<void> {
  while (true) {
    await Promise.allSettled(peers.map(p =>
      pollPeer(p).catch(err => {
        p.online = false;
        p.error  = err instanceof Error ? err.message : String(err);
      })
    ));
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

// ── Express app ───────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// Dashboard static files
let dashboardDir = path.join(process.cwd(), "dashboard");
if (!fs.existsSync(path.join(dashboardDir, "index.html"))) {
  dashboardDir = path.join(__dirname, "..", "..", "dashboard");
  if (!fs.existsSync(path.join(dashboardDir, "index.html"))) {
    dashboardDir = path.join(__dirname, "..", "dashboard");
  }
}
app.use(express.static(dashboardDir));
const dashboardIndex = path.join(dashboardDir, "index.html");

app.get("/",           (_req, res) => res.sendFile(dashboardIndex));
app.get("/dashboard",  (_req, res) => res.sendFile(dashboardIndex));
app.get("/dashboard/", (_req, res) => res.sendFile(dashboardIndex));

// ── Aggregated API endpoints ──────────────────────────────────────────────

app.get("/api/state", (_req, res) => {
  const onlinePeers = peers.filter(p => p.online);
  const n = onlinePeers.length || 1;

  let totalTokens    = 0;
  let totalPheromones = 0;
  let totalDiscoveries = 0;
  let totalThoughts  = 0;
  let sumEnergy      = 0;
  let sumDensity     = 0;
  let maxStep        = 0;
  let minStarted     = Date.now();
  let collectiveCount = 0;

  for (const peer of peers) {
    const s = peer.state;
    if (!s) continue;
    const m = s.metrics as Record<string, unknown> | undefined;
    totalTokens      += (s.totalTokens as number)          || 0;
    totalPheromones  += (m?.totalPheromones as number)     || peer.pheromones.length;
    totalDiscoveries += (m?.totalDiscoveries as number)    || 0;
    totalThoughts    += (m?.totalThoughts as number)       || peer.thoughts.length;
    sumEnergy        += (m?.avgEnergy as number)           || 0;
    sumDensity       += (s.density as number) || (m?.density as number) || 0;
    if ((s.step as number) > maxStep) maxStep = s.step as number;
    if ((s.startedAt as number) < minStarted) minStarted = s.startedAt as number;
    collectiveCount  += peer.collective.length;
  }

  res.json({
    hub:         true,
    peerCount:   peers.length,
    onlineCount: onlinePeers.length,
    step:        maxStep,
    startedAt:   minStarted,
    totalTokens,
    totalPRs:    0,
    density:     sumDensity / n,
    criticalThreshold: 0.55,
    metrics: {
      totalPheromones,
      totalDiscoveries,
      totalThoughts,
      avgEnergy:          sumEnergy / n,
      density:            sumDensity / n,
      collectiveMemoryCount: collectiveCount,
      uniqueDomainsExplored: new Set(
        peers.flatMap(p => p.pheromones.map((ph: unknown) =>
          (ph as { domain?: string }).domain || ""))
      ).size,
    },
    eigenDA: { enabled: false },
    peers: peers.map(p => ({
      url:         p.url,
      name:        p.name,
      online:      p.online,
      lastFetched: p.lastFetched,
      error:       p.error,
    })),
  });
});

app.get("/api/agents", (_req, res) => {
  res.json(peers.flatMap(p => p.agents));
});

app.get("/api/pheromones", (_req, res) => {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const peer of peers) {
    for (const ph of peer.pheromones) {
      const id = (ph as { id?: string }).id;
      if (id && !seen.has(id)) { seen.add(id); result.push(ph); }
    }
  }
  // Sort by timestamp descending
  result.sort((a, b) =>
    ((b as { timestamp?: number }).timestamp || 0) -
    ((a as { timestamp?: number }).timestamp || 0)
  );
  res.json(result);
});

app.get("/api/thoughts", (_req, res) => {
  const all = peers.flatMap(p => p.thoughts);
  all.sort((a, b) =>
    ((b as { timestamp?: number }).timestamp || 0) -
    ((a as { timestamp?: number }).timestamp || 0)
  );
  res.json(all.slice(0, 100));
});

app.get("/api/decisions", (_req, res) => {
  res.json([]);
});

app.get("/api/collective", (_req, res) => {
  res.json(peers.flatMap(p => p.collective));
});

app.get("/api/attestations", (_req, res) => {
  res.json(peers.flatMap(p => p.attestations));
});

app.get("/api/commitments", (_req, res) => {
  res.json(peers.flatMap(p => p.commitments));
});

app.get("/api/repos", (_req, res) => {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const peer of peers) {
    for (const r of peer.repos) {
      const topic = (r as { topic?: string }).topic;
      if (topic && !seen.has(topic)) { seen.add(topic); result.push(r); }
    }
  }
  res.json(result);
});

app.get("/api/report", (_req, res) => {
  const agentSummaries = peers.flatMap(p =>
    p.agents.map((a: unknown) => {
      const agent = a as Record<string, unknown>;
      return {
        name:           agent.name,
        specialization: agent.specialization,
        thoughtCount:   agent.thoughtCount || 0,
        tokensUsed:     agent.tokensUsed || 0,
        topConclusions: [],
      };
    })
  );

  const topInsights = peers.flatMap(p => p.thoughts)
    .filter((t: unknown) => ((t as { confidence?: number }).confidence || 0) > 0.5)
    .sort((a, b) =>
      ((b as { timestamp?: number }).timestamp || 0) -
      ((a as { timestamp?: number }).timestamp || 0)
    )
    .slice(0, 30);

  res.json({
    generatedAt:      Date.now(),
    hub:              true,
    swarmStep:        Math.max(...peers.map(p => (p.state?.step as number) || 0)),
    agentSummaries,
    topInsights,
    collectiveMemories: peers.flatMap(p => p.collective),
    reposStudied:     peers.flatMap(p => p.repos),
  });
});

// Forward agent detail requests to the right peer
app.get("/api/agent/:id", async (req, res) => {
  const id = req.params.id;
  for (const peer of peers) {
    const match = peer.agents.find((a: unknown) => (a as { id?: string }).id === id);
    if (match) {
      try {
        const r = await fetch(`${peer.url}/api/agent/${id}`, { signal: AbortSignal.timeout(5_000) });
        res.json(await r.json());
      } catch {
        res.json(match);
      }
      return;
    }
  }
  res.status(404).json({ error: "Agent not found" });
});

// Forward inject to all peers
app.post("/api/inject", async (req, res) => {
  const results = await Promise.allSettled(
    peers.map(p => fetch(`${p.url}/api/inject`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(req.body),
      signal:  AbortSignal.timeout(5_000),
    }))
  );
  const ok = results.filter(r => r.status === "fulfilled").length;
  res.json({ ok: true, injectedTo: ok });
});

// Hub-specific peer status
app.get("/api/peers", (_req, res) => {
  res.json(peers.map(p => ({
    url:         p.url,
    name:        p.name,
    online:      p.online,
    agentCount:  p.agents.length,
    lastFetched: p.lastFetched,
    error:       p.error,
  })));
});

app.get("/api/da-status", (_req, res) => {
  res.json({
    enabled: false, hub: true,
    pheromones: { total: 0, attested: 0, latest: [] },
    collectiveMemories: { total: 0, attested: 0, items: [] },
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok:    true,
    hub:   true,
    peers: peers.map(p => ({ name: p.name, online: p.online })),
  });
});

// ── Start ─────────────────────────────────────────────────────────────────

app.listen(HUB_PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║  SWARM MIND — HUB DASHBOARD                      ║`);
  console.log(`╠══════════════════════════════════════════════════╣`);
  console.log(`║  Port:     ${String(HUB_PORT).padEnd(38)} ║`);
  console.log(`║  Peers:    ${String(peers.length).padEnd(38)} ║`);
  for (const p of peers) {
    const label = p.url.replace(/^https?:\/\//, "").slice(0, 44);
    console.log(`║    → ${label.padEnd(44)} ║`);
  }
  console.log(`╚══════════════════════════════════════════════════╝\n`);

  if (peers.length === 0) {
    console.warn("[HUB] WARNING: No peers configured.");
    console.warn("[HUB]   Set PEER_URLS=http://kepler,http://hubble,http://voyager");
  }

  pollLoop().catch(err => console.error("[HUB] Poll loop crashed:", err));
});

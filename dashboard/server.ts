import express from "express";
import cors from "cors";
import path from "path";
import { SwarmState } from "../agents/types";
import { SwarmAgent } from "../agents/agent";

export function startDashboard(
  state: SwarmState,
  agents: SwarmAgent[],
  port: number
): void {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const dashboardDir = path.join(__dirname, "..", "..", "dashboard");
  app.use(express.static(dashboardDir));

  app.get("/api/state", (_req, res) => {
    res.json({
      step: state.step,
      startedAt: state.startedAt,
      phaseTransitionOccurred: state.phaseTransitionOccurred,
      transitionStep: state.transitionStep,
      metrics: state.metrics,
      density: state.channel.density,
      criticalThreshold: state.channel.criticalThreshold,
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
      }))
    );
  });

  app.get("/api/collective", (_req, res) => {
    res.json(state.collectiveMemories);
  });

  app.get("/", (_req, res) => {
    res.sendFile(path.join(dashboardDir, "index.html"));
  });

  app.listen(port, () => {
    console.log(`[DASHBOARD] http://localhost:${port}\n`);
  });
}

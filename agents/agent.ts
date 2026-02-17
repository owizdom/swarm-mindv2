import { v4 as uuid } from "uuid";
import {
  AgentState,
  Pheromone,
  PheromoneChannel,
  hash,
} from "./types";
import { discoverFromWeb, crossPollinateFromWeb } from "./scraper";

/**
 * Individual Swarm Agent — runs in its own TEE.
 *
 * Each agent AUTONOMOUSLY scours the internet for knowledge.
 * No API keys. No LLM. Pure web discovery.
 *
 * Sources: Wikipedia, ArXiv, Hacker News — all free, no auth.
 *
 * The agent explores its domain, fetches real knowledge from
 * the web, drops pheromones, picks up others', and searches
 * the internet for cross-domain connections.
 *
 * Above a critical pheromone density, agents spontaneously
 * synchronize — collective intelligence emerges.
 */

const DOMAINS = [
  "data structures and algorithms",
  "distributed systems architecture",
  "cryptographic primitives",
  "network protocols and security",
  "database optimization patterns",
  "compiler design techniques",
  "operating system internals",
  "machine learning optimization",
  "consensus mechanisms",
  "memory management strategies",
];

const NAMES = [
  "Neuron-A", "Neuron-B", "Neuron-C", "Neuron-D",
  "Neuron-E", "Neuron-F", "Neuron-G", "Neuron-H",
];

export class SwarmAgent {
  state: AgentState;
  private explored: Set<string> = new Set(); // topics already fetched from web

  constructor(index: number) {
    const angle = (index / 8) * Math.PI * 2;
    const radius = 300 + Math.random() * 200;

    this.state = {
      id: uuid(),
      name: NAMES[index] || `Neuron-${index}`,
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
      explorationTarget: DOMAINS[index % DOMAINS.length],
      energy: 0.3 + Math.random() * 0.3,
      synchronized: false,
      syncedWith: [],
      stepCount: 0,
      discoveries: 0,
      contributionsToCollective: 0,
    };
  }

  /** One exploration step */
  async step(channel: PheromoneChannel): Promise<Pheromone | null> {
    this.state.stepCount++;

    // 1. Move through exploration space
    this.move(channel);

    // 2. Absorb nearby pheromones from other agents
    const absorbed = this.absorbPheromones(channel);

    // 3. Explore — scour the internet for knowledge
    const discovery = await this.explore(absorbed);

    // 4. Check for synchronization
    this.checkSync(channel);

    return discovery;
  }

  /** Move through the abstract exploration space */
  private move(channel: PheromoneChannel): void {
    if (this.state.synchronized) {
      // Pull toward collective center
      const cx = 500, cy = 400;
      const pullStrength = 0.05;
      this.state.velocity.dx += (cx - this.state.position.x) * pullStrength;
      this.state.velocity.dy += (cy - this.state.position.y) * pullStrength;
      // Orbit
      this.state.velocity.dx += (this.state.position.y - cy) * 0.01;
      this.state.velocity.dy += -(this.state.position.x - cx) * 0.01;
    } else {
      // Brownian motion + pheromone attraction
      this.state.velocity.dx += (Math.random() - 0.5) * 4;
      this.state.velocity.dy += (Math.random() - 0.5) * 4;

      // Attracted to strong pheromones from others
      for (const p of channel.pheromones) {
        if (p.agentId === this.state.id) continue;
        if (this.state.absorbed.has(p.id)) continue;
        if (p.strength > 0.5) {
          this.state.velocity.dx += (Math.random() - 0.5) * p.strength * 3;
          this.state.velocity.dy += (Math.random() - 0.5) * p.strength * 3;
        }
      }
    }

    // Damping
    this.state.velocity.dx *= 0.85;
    this.state.velocity.dy *= 0.85;

    // Apply
    this.state.position.x += this.state.velocity.dx;
    this.state.position.y += this.state.velocity.dy;

    // Soft bounds
    this.state.position.x = Math.max(50, Math.min(950, this.state.position.x));
    this.state.position.y = Math.max(50, Math.min(750, this.state.position.y));
  }

  /** Pick up pheromones from the shared channel */
  private absorbPheromones(channel: PheromoneChannel): Pheromone[] {
    const absorbed: Pheromone[] = [];

    for (const p of channel.pheromones) {
      if (p.agentId === this.state.id) continue;
      if (this.state.absorbed.has(p.id)) continue;

      if (p.strength > 0.2 && Math.random() < p.strength * 0.6) {
        this.state.absorbed.add(p.id);
        absorbed.push(p);
        this.state.energy = Math.min(1.0, this.state.energy + 0.05);

        // Boost the original pheromone (positive feedback)
        p.strength = Math.min(1.0, p.strength + 0.1);
      }
    }

    return absorbed;
  }

  /** Explore — fetch real knowledge from the internet */
  private async explore(absorbed: Pheromone[]): Promise<Pheromone | null> {
    const discoveryChance = this.state.synchronized ? 0.7 : 0.4;
    if (Math.random() > discoveryChance) return null;

    let content: string;
    let domain = this.state.explorationTarget;
    let connections: string[] = [];
    let confidence: number;

    if (absorbed.length > 0 && Math.random() < 0.6) {
      // CROSS-POLLINATION: search the internet for connections
      // between absorbed knowledge and our own domain
      const source = absorbed[Math.floor(Math.random() * absorbed.length)];
      connections = [source.id];
      confidence = Math.min(1.0, source.confidence + 0.1);
      domain = source.domain;

      // Try web cross-pollination first
      const webBridge = await crossPollinateFromWeb(
        this.state.explorationTarget,
        source.content,
        source.domain,
        this.explored
      );

      if (webBridge) {
        content = webBridge.content;
        console.log(
          `    ${this.state.name} 🌐 web bridge: ${webBridge.source}`
        );
      } else {
        // Fallback: generate from hardcoded pool
        content = this.fallbackInsight(source);
      }

      // Shift exploration toward productive areas
      if (source.strength > 0.6) {
        this.state.explorationTarget = source.domain;
      }
    } else {
      // INDEPENDENT DISCOVERY: scour the internet for knowledge
      const webDiscovery = await discoverFromWeb(
        this.state.explorationTarget,
        this.explored
      );

      if (webDiscovery) {
        content = webDiscovery.content;
        confidence = 0.4 + Math.random() * 0.4; // web sources get higher base confidence
        console.log(
          `    ${this.state.name} 🌐 web discovery: ${webDiscovery.source}`
        );
      } else {
        // Fallback: hardcoded pool (no internet or all topics explored)
        content = this.fallbackDiscovery();
        confidence = 0.3 + Math.random() * 0.4;
      }
    }

    const pheromone: Pheromone = {
      id: uuid(),
      agentId: this.state.id,
      content,
      domain,
      confidence,
      strength: 0.5 + confidence * 0.3,
      connections,
      timestamp: Date.now(),
      attestation: hash(content + this.state.id + Date.now()),
    };

    this.state.knowledge.push(pheromone);
    this.state.discoveries++;

    return pheromone;
  }

  /** Check if this agent should synchronize with the collective */
  private checkSync(channel: PheromoneChannel): void {
    if (this.state.synchronized) return;

    if (
      channel.density >= channel.criticalThreshold &&
      this.state.absorbed.size >= 3 &&
      this.state.energy > 0.5
    ) {
      this.state.synchronized = true;
      this.state.energy = 1.0;
      console.log(
        `  [${this.state.name}] SYNCHRONIZED with collective (absorbed ${this.state.absorbed.size} pheromones)`
      );
    }
  }

  // ── Fallback pools (only used when web sources are unavailable) ──

  private fallbackInsight(source: Pheromone): string {
    const insights: Record<string, string[]> = {
      "data structures and algorithms": [
        "Combining skip lists with bloom filters creates a probabilistic data structure that offers O(log n) search with O(1) membership testing — useful for distributed caches.",
        "Applying the van Emde Boas tree layout to the discovered B-tree variant could reduce cache misses by 40% on modern CPUs with large L3 caches.",
        "Persistent data structures using path copying can be made lock-free by combining with the discovered CAS-based approach, enabling wait-free snapshots.",
      ],
      "distributed systems architecture": [
        "The discovered consensus optimization maps to a lattice structure — CRDT-style merge functions could eliminate coordination overhead entirely for monotonic state.",
        "Applying epidemic/gossip protocols to this discovery suggests that O(log n) rounds suffice for cluster-wide consistency with high probability.",
        "Vector clocks can be compressed using this insight — interval tree clocks reduce metadata from O(n) to O(1) for causality tracking.",
      ],
      "cryptographic primitives": [
        "This hash construction is structurally similar to a sponge function — wrapping it in a duplex construction would yield an authenticated encryption scheme.",
        "Combining this with Merkle mountain ranges yields an append-only commitment scheme with O(log n) proof size and O(1) amortized append.",
        "The algebraic structure here maps to pairing-based cryptography — BLS signatures could be aggregated using this as a base, saving 90% bandwidth.",
      ],
      "network protocols and security": [
        "Applying QUIC's 0-RTT handshake pattern to this discovery eliminates one round-trip for authenticated channel establishment in mesh networks.",
        "This TCP optimization can be generalized using eBPF — kernel-bypass packet processing achieves 10M pps on commodity hardware.",
        "Combining Wireguard's Noise framework with this insight creates a post-quantum secure tunnel with only 1 additional RTT.",
      ],
      "database optimization patterns": [
        "LSM-tree compaction can leverage this by using fractional cascading between levels, reducing read amplification from O(L) to O(log L).",
        "Applying learned indexes to this B-tree variant reduces storage overhead by 60% while maintaining worst-case O(log n) lookup guarantees.",
        "Zone maps combined with this insight enable predicate pushdown that skips 95% of irrelevant pages in columnar storage.",
      ],
      "compiler design techniques": [
        "This optimization pass is equivalent to partial evaluation — applying it at the SSA level yields 2-3x speedup for loop-heavy code.",
        "Polyhedral compilation can model this loop transformation, enabling automatic GPU offloading with provable correctness guarantees.",
        "Combining this with profile-guided optimization turns speculative devirtualization from 60% hit rate to 95%.",
      ],
      "consensus mechanisms": [
        "This leader election approach maps to a verifiable random function — combining with threshold signatures yields asynchronous consensus in O(1) expected rounds.",
        "DAG-based consensus can absorb this optimization to achieve 100k+ TPS by parallelizing block proposal and vote collection.",
        "Applying HotStuff's pipelining to this protocol reduces latency from 3 round-trips to 1 for the common case.",
      ],
      "operating system internals": [
        "This scheduling insight applies to io_uring — adaptive polling with this heuristic reduces syscall overhead by 70% for mixed workloads.",
        "Combining huge pages with this memory mapping approach eliminates TLB thrashing for workloads exceeding 256GB working set.",
        "The discovered preemption pattern is equivalent to cooperative scheduling with deadlines — provably prevents priority inversion.",
      ],
      "machine learning optimization": [
        "This gradient technique maps to Lion optimizer — combining momentum with sign-based updates yields 2x memory savings vs Adam.",
        "Applying mixture of experts routing to this layer structure achieves 90% of dense model quality with 10% of compute per token.",
        "Flash attention's tiling strategy combined with this insight reduces KV-cache memory from O(n^2) to O(n*sqrt(n)).",
      ],
      "memory management strategies": [
        "Slab allocation with this size-class heuristic reduces internal fragmentation from 25% to under 3% for real-world allocation patterns.",
        "Combining jemalloc's arena approach with this thread-local insight eliminates lock contention entirely for allocations under 4KB.",
        "This discovery maps to region-based memory management — scoped arenas with deferred cleanup achieve zero-overhead RAII.",
      ],
    };

    const domainInsights = insights[source.domain] || insights["data structures and algorithms"];
    return domainInsights[Math.floor(Math.random() * domainInsights.length)];
  }

  private fallbackDiscovery(): string {
    const discoveries: Record<string, string[]> = {
      "data structures and algorithms": [
        "A cache-oblivious B-tree using van Emde Boas layout achieves optimal I/O complexity without knowing the memory hierarchy parameters.",
        "Finger trees with monoid annotations enable O(log n) split and merge while supporting any associative summary operation.",
        "Cuckoo hashing with a stash of O(log log n) elements achieves O(1) worst-case lookup with 95% load factor.",
      ],
      "distributed systems architecture": [
        "Raft's leader lease optimization allows linearizable reads without log replication, reducing read latency to a single local disk seek.",
        "Virtual synchrony with optimistic delivery reorders messages for throughput while preserving causal consistency guarantees.",
        "CRDTs over delta-state propagation reduce bandwidth by 100x compared to state-based CRDTs in sparse update patterns.",
      ],
      "cryptographic primitives": [
        "Poseidon hash function designed for arithmetic circuits achieves 8x fewer constraints than Pedersen hash in ZK-SNARK proofs.",
        "Verkle trees using inner product arguments reduce witness size from O(k*log n) to O(log n) compared to Merkle trees with branching factor k.",
        "Bulletproofs+ achieve 15% smaller proofs than original Bulletproofs by exploiting the algebraic structure of the inner product relation.",
      ],
      "network protocols and security": [
        "DPDK with RSS hashing enables 100Gbps line-rate packet processing using 8 CPU cores with zero kernel involvement.",
        "BBRv3 congestion control achieves 2x throughput over CUBIC on networks with 1% random packet loss.",
        "DNS-over-QUIC reduces resolution latency to 0-RTT for repeat queries while providing full encryption and authentication.",
      ],
      "database optimization patterns": [
        "Adaptive radix trees compress sparse key spaces from 256-way nodes to 4/16/48/256 variants, reducing memory by 85%.",
        "Buffer pool anti-caching with SSD-backed eviction extends effective memory by 10x with only 5% performance overhead.",
        "Morsel-driven parallelism automatically adapts query execution to NUMA topology, achieving linear scaling to 64 cores.",
      ],
      "compiler design techniques": [
        "Sea of nodes IR eliminates the CFG/SSA duality, enabling constant-time node replacement and O(n) global value numbering.",
        "Superword level parallelism (SLP) vectorization discovers SIMD opportunities that traditional loop vectorization misses in straight-line code.",
        "Live range splitting based on loop nesting depth reduces register pressure by 30% compared to linear scan allocation.",
      ],
      "consensus mechanisms": [
        "Narwhal mempool decouples data availability from consensus ordering, achieving 160k TPS by parallelizing block dissemination.",
        "Tendermint's lock-change mechanism prevents equivocation with only 2 message delays in the common case.",
        "Avalanche's metastable consensus achieves finality in 1-2 seconds with subsampled voting among 1000+ validators.",
      ],
      "operating system internals": [
        "io_uring's submission queue batching amortizes syscall overhead — a single syscall can dispatch 256 I/O operations.",
        "eBPF JIT compilation executes sandboxed programs at near-native speed inside the kernel, enabling 10M events/sec tracing.",
        "KPTI shadow page tables isolate kernel memory from userspace with only 0.3% overhead on modern CPUs with PCID support.",
      ],
      "machine learning optimization": [
        "Ring attention distributes attention computation across devices by chunking the KV-cache, enabling million-token context with linear memory scaling.",
        "Quantization-aware training with GPTQ achieves 4-bit weights with less than 1% quality loss on LLM benchmarks.",
        "Speculative decoding with a small draft model achieves 2-3x generation speedup without any quality degradation.",
      ],
      "memory management strategies": [
        "Thread-caching malloc (tcmalloc) keeps per-thread free lists for common sizes, eliminating lock contention for 99% of allocations.",
        "Transparent huge pages with khugepaged merging reduce TLB misses by 80% for heap-heavy applications without code changes.",
        "Hazard pointers enable lock-free memory reclamation with O(N) space overhead where N is the number of threads.",
      ],
    };

    const domain = this.state.explorationTarget;
    const pool = discoveries[domain] || discoveries["data structures and algorithms"];
    return pool[Math.floor(Math.random() * pool.length)];
  }
}

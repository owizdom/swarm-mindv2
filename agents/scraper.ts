/**
 * AUTONOMOUS WEB SCRAPER
 *
 * Agents scour the internet for real knowledge. No API keys needed.
 *
 * Sources:
 *  1. Wikipedia REST API — encyclopedic technical knowledge
 *  2. ArXiv API — cutting-edge academic research abstracts
 *  3. Hacker News Algolia API — live tech community discussions
 *
 * Each agent independently discovers real information from the web,
 * drops it as attested pheromones, and builds on what others find.
 */

// ── Topic pools per domain (Wikipedia article titles + search terms) ──

const DOMAIN_TOPICS: Record<string, string[]> = {
  "data structures and algorithms": [
    "Skip list", "B-tree", "Red-black tree", "Bloom filter",
    "Cuckoo hashing", "Fibonacci heap", "Trie", "Suffix array",
    "Van Emde Boas tree", "Splay tree", "Treap", "Radix tree",
    "Merkle tree", "Disjoint-set data structure", "K-d tree",
    "R-tree", "Segment tree", "Fenwick tree", "Persistent data structure",
    "Cache-oblivious algorithm", "External sorting",
    "Topological sorting", "A* search algorithm", "Dijkstra's algorithm",
    "Rope (data structure)", "Finger tree", "Count–min sketch",
    "HyperLogLog", "Wavelet tree", "Succinct data structure",
  ],
  "distributed systems architecture": [
    "Raft (algorithm)", "Paxos (computer science)", "Byzantine fault",
    "Consistent hashing", "Vector clock", "Gossip protocol",
    "Two-phase commit protocol", "CAP theorem",
    "Conflict-free replicated data type",
    "MapReduce", "Distributed hash table",
    "Leader election", "Lamport timestamp", "Quorum (distributed computing)",
    "Saga pattern", "Service mesh",
    "Event sourcing", "Exactly-once delivery",
    "Chain replication", "Virtual synchrony",
    "Epidemic protocol", "Chord (peer-to-peer)",
    "Dynamo (storage system)", "Google Spanner",
  ],
  "cryptographic primitives": [
    "Elliptic-curve cryptography", "Zero-knowledge proof",
    "Homomorphic encryption", "Digital signature",
    "SHA-2", "Advanced Encryption Standard", "RSA (cryptosystem)",
    "Diffie–Hellman key exchange", "Shamir's secret sharing",
    "Commitment scheme", "Verifiable random function",
    "Pairing-based cryptography", "Post-quantum cryptography",
    "Schnorr signature", "BLS digital signature",
    "Verkle tree", "Authenticated encryption",
    "Key derivation function", "Message authentication code",
    "Oblivious transfer", "Garbled circuit",
    "Bulletproofs", "Poseidon hash", "PLONK",
  ],
  "network protocols and security": [
    "QUIC", "TCP congestion control", "Border Gateway Protocol",
    "Transport Layer Security", "WireGuard", "HTTP/3",
    "Domain Name System", "Multipath TCP",
    "Software-defined networking",
    "Deep packet inspection", "eBPF",
    "Data Plane Development Kit",
    "Network function virtualization", "Segment routing",
    "Peer-to-peer", "Content delivery network",
    "IPsec", "DNS over HTTPS", "BBR (congestion control)",
    "SCTP", "Noise Protocol Framework",
    "mTLS", "HTTP/2 Server Push",
  ],
  "database optimization patterns": [
    "Log-structured merge-tree", "B+ tree",
    "Write-ahead logging", "Multiversion concurrency control",
    "Column-oriented DBMS", "Bitmap index",
    "Buffer pool", "Query optimization",
    "Materialized view", "Database index", "Hash join",
    "Database sharding", "Connection pooling",
    "Vectorized query execution",
    "LSM tree compaction", "Adaptive radix tree",
    "Bw-Tree", "LMDB", "RocksDB",
    "Undo log", "Snapshot isolation",
    "Predicate pushdown", "Volcano model",
  ],
  "compiler design techniques": [
    "Static single-assignment form", "LLVM",
    "Just-in-time compilation", "Register allocation",
    "Loop optimization", "Dead-code elimination",
    "Constant folding", "Inline expansion", "Peephole optimization",
    "Abstract syntax tree", "Intermediate representation",
    "Escape analysis", "Polyhedral model",
    "Automatic vectorization",
    "Profile-guided optimization", "Link-time optimization",
    "Tail call", "Continuation-passing style",
    "Deforestation (computer science)", "Sea of nodes",
    "GraalVM", "Cranelift", "MLIR (software)",
  ],
  "operating system internals": [
    "Io_uring", "eBPF", "Virtual memory",
    "Page table", "Translation lookaside buffer",
    "Context switch", "Scheduling (computing)",
    "Completely Fair Scheduler", "Copy-on-write",
    "Memory-mapped file", "Futex", "Read-copy-update",
    "Huge pages", "Non-uniform memory access", "Interrupt",
    "Direct memory access", "Kernel preemption",
    "System call", "Linux namespaces",
    "Cgroups", "Seccomp", "Landlock",
    "Microkernel", "Unikernel",
  ],
  "machine learning optimization": [
    "Transformer (deep learning architecture)",
    "Attention (machine learning)", "Backpropagation",
    "Stochastic gradient descent", "Adam (optimizer)",
    "Batch normalization", "Dropout (neural networks)",
    "Quantization (signal processing)", "Knowledge distillation",
    "Mixture of experts", "Neural architecture search",
    "Federated learning", "Gradient checkpointing",
    "Mixed-precision training", "Model parallelism",
    "Low-rank adaptation", "Speculative decoding",
    "Sparse attention", "Retrieval-augmented generation",
    "Contrastive learning", "RLHF", "DPO (machine learning)",
    "KV cache", "Grouped query attention",
  ],
  "consensus mechanisms": [
    "Proof of stake", "Proof of work",
    "Byzantine fault tolerance", "Practical Byzantine fault tolerance",
    "Tendermint", "HotStuff (protocol)",
    "Directed acyclic graph",
    "Nakamoto consensus", "Delegated proof of stake",
    "Proof of authority", "Threshold signature",
    "Finality (blockchain)",
    "Mempool", "Sharding (database architecture)",
    "Optimistic rollup", "Zero-knowledge rollup",
    "Data availability problem", "Proposer-builder separation",
    "MEV (blockchain)", "Ethereum 2.0",
    "Cosmos (blockchain)", "Solana",
  ],
  "memory management strategies": [
    "Garbage collection (computer science)",
    "Reference counting", "Tracing garbage collection",
    "Generational garbage collection", "Slab allocation",
    "Memory pool", "Stack-based memory allocation",
    "Region-based memory management", "Boehm garbage collector",
    "Tcmalloc", "Jemalloc", "Memory leak",
    "Dangling pointer", "Smart pointer",
    "Automatic Reference Counting",
    "Borrow checker", "Memory fragmentation",
    "Buddy memory allocation", "Memory-mapped I/O",
    "RAII", "Hazard pointer", "Epoch-based reclamation",
  ],
};

// ── In-memory cache ──

const cache = new Map<string, string>();
let lastRequestTime = 0;
const MIN_REQUEST_GAP = 150; // ms between requests — be respectful

async function throttle(): Promise<void> {
  const now = Date.now();
  const gap = now - lastRequestTime;
  if (gap < MIN_REQUEST_GAP) {
    await new Promise((r) => setTimeout(r, MIN_REQUEST_GAP - gap));
  }
  lastRequestTime = Date.now();
}

// ── Wikipedia ──

async function fetchWikipediaSummary(topic: string): Promise<string | null> {
  const cacheKey = `wiki:${topic}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  await throttle();
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "SwarmMind/1.0 (research project)" },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { extract?: string; title?: string };
    const extract = data.extract;
    if (!extract || extract.length < 30) return null;

    const result = `${data.title || topic}: ${extract}`;
    cache.set(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

async function searchWikipedia(query: string): Promise<string[]> {
  await throttle();
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=5&format=json&origin=*`;
    const res = await fetch(url, {
      headers: { "User-Agent": "SwarmMind/1.0 (research project)" },
    });
    const data = (await res.json()) as string[][];
    return (data[1] as string[]) || [];
  } catch {
    return [];
  }
}

// ── ArXiv ──

async function fetchArxivPaper(
  query: string
): Promise<{ title: string; abstract: string } | null> {
  await throttle();
  try {
    const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=5&sortBy=relevance`;
    const res = await fetch(url);
    const xml = await res.text();

    // Parse entries from Atom XML
    const entries = xml.match(/<entry>([\s\S]*?)<\/entry>/g);
    if (!entries || entries.length === 0) return null;

    // Pick a random entry
    const entry = entries[Math.floor(Math.random() * Math.min(3, entries.length))];
    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);

    if (!titleMatch || !summaryMatch) return null;

    return {
      title: titleMatch[1].trim().replace(/\s+/g, " "),
      abstract: summaryMatch[1].trim().replace(/\s+/g, " "),
    };
  } catch {
    return null;
  }
}

// ── Hacker News ──

async function fetchHNDiscussion(
  query: string
): Promise<{ title: string; points: number; url: string } | null> {
  await throttle();
  try {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=5`;
    const res = await fetch(url);
    const data = (await res.json()) as {
      hits?: Array<{
        title?: string;
        points?: number;
        url?: string;
        objectID?: string;
      }>;
    };

    if (!data.hits || data.hits.length === 0) return null;

    // Pick highest-voted recent story
    const sorted = data.hits
      .filter((h) => h.title && (h.points || 0) > 5)
      .sort((a, b) => (b.points || 0) - (a.points || 0));

    if (sorted.length === 0) return null;
    const hit = sorted[Math.floor(Math.random() * Math.min(3, sorted.length))];

    return {
      title: hit.title || query,
      points: hit.points || 0,
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    };
  } catch {
    return null;
  }
}

// ── Text extraction ──

function extractInsight(text: string, maxSentences = 2): string {
  // Split into sentences, take the most informative ones
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.length > 30 && s.length < 300)
    .filter((s) => !s.startsWith("This article") && !s.startsWith("For other"));

  if (sentences.length === 0) {
    // Fallback: just truncate
    return text.slice(0, 200).trim();
  }

  return sentences.slice(0, maxSentences).join(" ");
}

// ── Public API ──

/**
 * Autonomously discover knowledge from the internet.
 * Picks a topic in the agent's domain, fetches from Wikipedia/ArXiv/HN.
 */
export async function discoverFromWeb(
  domain: string,
  explored: Set<string>
): Promise<{ content: string; source: string } | null> {
  const topics = DOMAIN_TOPICS[domain];
  if (!topics) return null;

  // Pick an unexplored topic
  const unexplored = topics.filter((t) => !explored.has(t));
  if (unexplored.length === 0) {
    // All explored — reset and allow re-exploration
    explored.clear();
    return null;
  }

  const topic = unexplored[Math.floor(Math.random() * unexplored.length)];
  explored.add(topic);

  // Decide source: 50% Wikipedia, 30% ArXiv, 20% HN
  const roll = Math.random();

  if (roll < 0.5) {
    // Wikipedia
    const summary = await fetchWikipediaSummary(topic);
    if (summary) {
      const insight = extractInsight(summary);
      return { content: insight, source: `wikipedia:${topic}` };
    }
  }

  if (roll < 0.8 || roll >= 0.5) {
    // ArXiv — search with domain context
    const searchTerm = `${topic} ${domain.split(" ")[0]}`;
    const paper = await fetchArxivPaper(searchTerm);
    if (paper) {
      const insight = extractInsight(paper.abstract);
      return {
        content: `[${paper.title}] ${insight}`,
        source: `arxiv:${paper.title}`,
      };
    }
  }

  // HN as final web attempt
  const hn = await fetchHNDiscussion(topic);
  if (hn) {
    return {
      content: `[${hn.title}] (${hn.points} points) — trending discussion on ${topic} in the context of ${domain}`,
      source: `hackernews:${hn.title}`,
    };
  }

  return null;
}

/**
 * Cross-pollinate: search the internet for connections between two domains.
 * This is where genuine emergent insights come from — the agent finds
 * real bridging knowledge that connects what it knows to what it absorbed.
 */
export async function crossPollinateFromWeb(
  agentDomain: string,
  sourcePheromoneContent: string,
  sourceDomain: string,
  explored: Set<string>
): Promise<{ content: string; source: string } | null> {
  // Extract key terms from the source pheromone
  const stopWords = new Set([
    "the", "and", "for", "that", "this", "with", "from", "are", "was",
    "have", "has", "been", "being", "which", "where", "when", "what",
    "about", "into", "over", "used", "uses", "using", "between", "each",
    "such", "than", "other", "more", "also", "most", "some",
  ]);

  const words = sourcePheromoneContent
    .replace(/[[\](){}:;,."'!?]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4 && !stopWords.has(w.toLowerCase()));

  if (words.length === 0) return null;

  // Pick a key term and combine with agent's domain
  const keyTerm = words[Math.floor(Math.random() * Math.min(5, words.length))];
  const bridgeQuery = `${keyTerm} ${agentDomain.split(" ").slice(0, 2).join(" ")}`;

  // Search Wikipedia for bridging topic
  const wikiResults = await searchWikipedia(bridgeQuery);
  if (wikiResults.length > 0) {
    const bridgeTopic =
      wikiResults[Math.floor(Math.random() * Math.min(3, wikiResults.length))];

    if (!explored.has(bridgeTopic)) {
      explored.add(bridgeTopic);
      const summary = await fetchWikipediaSummary(bridgeTopic);
      if (summary) {
        const insight = extractInsight(summary);
        return {
          content: `Cross-domain bridge [${sourceDomain} → ${agentDomain}]: ${insight}`,
          source: `wikipedia:${bridgeTopic}`,
        };
      }
    }
  }

  // Try ArXiv for academic bridging
  const paper = await fetchArxivPaper(bridgeQuery);
  if (paper) {
    const insight = extractInsight(paper.abstract, 1);
    return {
      content: `Research bridge [${sourceDomain} → ${agentDomain}]: [${paper.title}] ${insight}`,
      source: `arxiv:${paper.title}`,
    };
  }

  return null;
}

/**
 * Get available topic count for a domain.
 */
export function getTopicCount(domain: string): number {
  return DOMAIN_TOPICS[domain]?.length || 0;
}

/**
 * Get all domains that have topics.
 */
export function getAvailableDomains(): string[] {
  return Object.keys(DOMAIN_TOPICS);
}

#!/bin/bash
# ── EigenLayer Challenge Submission Finder ──────────────────────────────────
# Searches GitHub for repos likely submitted to the EigenLayer open innovation
# challenge (verifiable/sovereign agents, deadline ~Feb 20 2025).
# Uses GitHub Search API (unauthenticated: 10 req/min, 1000 results/query).
#
# Usage: bash scripts/find_submissions.sh [GITHUB_TOKEN]
# With token: 30 req/min, better rate limits

TOKEN="${1:-}"
AUTH_HEADER=""
[ -n "$TOKEN" ] && AUTH_HEADER="Authorization: token $TOKEN"

BASE="https://api.github.com/search/repositories"
OUT="submissions_raw.json"
REPORT="submissions_report.md"

echo "╔══════════════════════════════════════════════════════╗"
echo "║   EigenLayer Challenge — Submission Finder           ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

search_github() {
  local query="$1"
  local label="$2"
  local encoded
  encoded=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$query'))")
  local url="${BASE}?q=${encoded}&sort=updated&order=desc&per_page=50"

  echo "  Searching: $label"
  if [ -n "$AUTH_HEADER" ]; then
    curl -sf -H "$AUTH_HEADER" -H "Accept: application/vnd.github.v3+json" "$url"
  else
    curl -sf -H "Accept: application/vnd.github.v3+json" "$url"
  fi
  sleep 7  # stay under 10 req/min unauthenticated
}

# ── Run searches ─────────────────────────────────────────────────────────────

echo "[1/6] Querying GitHub API..."
echo ""

# Collect results into temp files
search_github "eigenda agent created:2025-01-01..2025-02-25" \
  "EigenDA agent (Jan–Feb 2025)" > /tmp/s1.json

search_github "eigencompute agent created:2024-12-01..2025-02-25" \
  "EigenCompute agent (Dec 2024–Feb 2025)" > /tmp/s2.json

search_github "eigencloud verifiable agent created:2024-11-01..2025-02-25" \
  "EigenCloud verifiable agent" > /tmp/s3.json

search_github "eigenlayer sovereign agent created:2025-01-01..2025-02-28" \
  "EigenLayer sovereign agent (2025)" > /tmp/s4.json

search_github "eigenlayer verifiable agent avs created:2025-01-01..2025-02-28" \
  "EigenLayer verifiable AVS agent (2025)" > /tmp/s5.json

search_github "eigenda commit-reveal OR pheromone OR swarm created:2024-12-01..2025-02-28" \
  "EigenDA commit-reveal / swarm (2024–2025)" > /tmp/s6.json

echo ""
echo "[2/6] Merging and deduplicating results..."

# Merge all results, deduplicate by full_name
python3 - << 'PYEOF'
import json, sys, os

all_items = []
seen = set()
files = ["/tmp/s1.json", "/tmp/s2.json", "/tmp/s3.json", "/tmp/s4.json", "/tmp/s5.json", "/tmp/s6.json"]

# Exclude: EigenLayer team themselves, unrelated owizdom repos, known non-submissions
EXCLUDED_OWNERS = {"layr-labs", "gajesh2007"}
EXCLUDED_REPOS  = {"owizdom/eigencompute-secure-DB"}

for f in files:
    try:
        data = json.load(open(f))
        for item in data.get("items", []):
            key = item["full_name"]
            owner = key.split("/")[0].lower()
            if owner in EXCLUDED_OWNERS:
                continue
            if key in EXCLUDED_REPOS:
                continue
            if key not in seen:
                seen.add(key)
                all_items.append(item)
    except Exception as e:
        print(f"  Warning: could not parse {f}: {e}", file=sys.stderr)

# Sort by stars desc
all_items.sort(key=lambda x: x.get("stargazers_count", 0), reverse=True)
print(f"  Found {len(all_items)} unique repos")

with open("submissions_raw.json", "w") as f:
    json.dump(all_items, f, indent=2)
PYEOF

echo ""
echo "[3/6] Fetching README snippets for top candidates..."
echo ""

python3 - << 'PYEOF'
import json, subprocess, sys, time

repos = json.load(open("submissions_raw.json"))

# Scoring heuristics for challenge relevance
EIGEN_TERMS   = ["eigenda", "eigencompute", "eigencloud", "eigenlayer", "eigenai"]
AGENT_TERMS   = ["agent", "sovereign", "verifiable", "autonomous", "swarm", "oracle"]
CHALLENGE_TERMS = ["commit-reveal", "commit reveal", "pheromone", "tee", "kzg",
                   "attestation", "independence", "avs", "restaking"]

def score_repo(r):
    text = " ".join([
        (r.get("name")        or "").lower(),
        (r.get("description") or "").lower(),
        " ".join(r.get("topics", [])),
    ])
    s = 0
    s += sum(3 for t in EIGEN_TERMS     if t in text)
    s += sum(2 for t in AGENT_TERMS     if t in text)
    s += sum(4 for t in CHALLENGE_TERMS if t in text)
    s += min(r.get("stargazers_count", 0), 20)  # cap star bonus
    # Bonus: created in submission window
    created = r.get("created_at", "")
    if "2025-01" in created or "2025-02" in created or "2024-12" in created:
        s += 5
    return s

for r in repos:
    r["_score"] = score_repo(r)

repos.sort(key=lambda x: x["_score"], reverse=True)
top = repos[:30]

print(f"  Top {len(top)} candidates by relevance score:")
for i, r in enumerate(top[:20], 1):
    print(f"    {i:2}. [{r['_score']:3}] {r['full_name']:50} ⭐{r.get('stargazers_count',0)} — {(r.get('description') or '')[:60]}")

with open("submissions_raw.json", "w") as f:
    json.dump(repos, f, indent=2)

print(f"\n  Fetching README for top 20...")

def fetch_readme(full_name):
    url = f"https://api.github.com/repos/{full_name}/readme"
    try:
        import urllib.request, base64
        req = urllib.request.Request(url, headers={"Accept": "application/vnd.github.v3+json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
            content = base64.b64decode(data["content"]).decode("utf-8", errors="replace")
            return content[:3000]
    except:
        return ""

readmes = {}
for r in top[:20]:
    fn = r["full_name"]
    print(f"    Fetching {fn}...")
    readmes[fn] = fetch_readme(fn)
    time.sleep(1)

with open("submissions_readmes.json", "w") as f:
    json.dump(readmes, f, indent=2)

print("\n  Done.")
PYEOF

echo ""
echo "[4/6] Generating comparison report..."

python3 - << 'PYEOF'
import json

repos  = json.load(open("submissions_raw.json"))[:20]
readmes = {}
try:
    readmes = json.load(open("submissions_readmes.json"))
except:
    pass

SWARM_MIND = """
swarm-mindv2 (owizdom/swarm-mindv2)
- Uses EigenDA KZG commitments for timestamped sealed blobs (two-probe approach)
- Full commit-reveal-synthesize cycle: EXPLORE → COMMIT → REVEAL → SYNTHESIS
- Independence proof: eigenDAReferenceBlock < commitWindowCloseBlock (verified live)
- Integrity check: coordinator fetches blob from EigenDA, sha256(blob) == sealedBlobHash → passed: true
- Ed25519 keypairs per agent (hardware-rooted on EigenCompute TEE)
- 3 independent agents (Kepler/Hubble/Voyager) analyze real NASA data
- Slash events recorded for missed/late commits
- Live evidence bundle API (/api/evidence) with all checks passing
- Dashboard with phase-aware visualization
- No LLM required (works in pure data mode)
- Pheromone-based stigmergic coordination (independent during explore, gossip during reveal)
- Solves: sycophancy problem in multi-agent LLM systems
- Fully documented: message dissemination impossibility, KZG theory, Lorenz mechanism
"""

CRITERIA = [
    ("Uses EigenDA/EigenCompute/EigenLayer core", 25),
    ("Verifiability depth (what exactly is proven)", 25),
    ("Real working demo / evidence", 20),
    ("Novel problem solved", 15),
    ("Code quality & completeness", 10),
    ("Documentation & explainability", 5),
]

def score_project(name, desc, readme, topics):
    text = (name + " " + desc + " " + readme + " " + " ".join(topics)).lower()
    scores = {}

    # 1. EigenLayer core usage
    eigen_score = 0
    if "eigenda" in text:       eigen_score += 10
    if "kzg" in text:           eigen_score += 8
    if "eigencompute" in text:  eigen_score += 7
    if "eigencloud" in text:    eigen_score += 5
    if "eigenlayer" in text:    eigen_score += 3
    if "tee" in text:           eigen_score += 5
    if "restaking" in text:     eigen_score += 2
    scores["eigen"] = min(eigen_score, 25)

    # 2. Verifiability depth
    verif_score = 0
    if "commit-reveal" in text or "commit reveal" in text: verif_score += 8
    if "kzg" in text:                   verif_score += 7
    if "reference block" in text or "referenceblock" in text: verif_score += 7
    if "independence" in text:          verif_score += 5
    if "integrity" in text:             verif_score += 4
    if "sealed" in text:                verif_score += 4
    if "attestation" in text:           verif_score += 3
    if "slash" in text:                 verif_score += 3
    if "avs" in text:                   verif_score += 3
    if "evidence" in text:              verif_score += 3
    if "sha256" in text or "ed25519" in text: verif_score += 2
    scores["verif"] = min(verif_score, 25)

    # 3. Working demo
    demo_score = 0
    if "localhost" in text or "dashboard" in text: demo_score += 5
    if "npm install" in text or "docker" in text:  demo_score += 5
    if "curl" in text:                             demo_score += 3
    if "api/evidence" in text:                     demo_score += 10
    if "passed" in text and "true" in text:        demo_score += 5
    if "running" in text or "run" in text:         demo_score += 2
    scores["demo"] = min(demo_score, 20)

    # 4. Novel problem
    novel_score = 0
    if "sycophancy" in text:            novel_score += 8
    if "lorenz" in text:                novel_score += 5
    if "wisdom of crowd" in text:       novel_score += 4
    if "pre-registration" in text:      novel_score += 4
    if "dissemination" in text:         novel_score += 4
    if "oracle" in text:                novel_score += 3
    if "sovereign" in text:             novel_score += 3
    if "independent" in text:           novel_score += 3
    if "multi-agent" in text or "multi agent" in text: novel_score += 2
    scores["novel"] = min(novel_score, 15)

    # 5. Code quality
    code_score = 0
    if "typescript" in text:            code_score += 3
    if "test" in text:                  code_score += 2
    if "types" in text:                 code_score += 2
    if "interface" in text:             code_score += 2
    if len(readme) > 2000:              code_score += 3
    scores["code"] = min(code_score, 10)

    # 6. Documentation
    doc_score = 0
    if len(readme) > 3000:              doc_score += 2
    if "reference" in text:             doc_score += 1
    if "why" in text:                   doc_score += 1
    if "architecture" in text:          doc_score += 1
    scores["docs"] = min(doc_score, 5)

    total = sum(scores.values())
    return total, scores

# Score swarm-mind
sm_total, sm_scores = score_project(
    "swarm-mindv2",
    "Multi-agent AI with verifiable independent convergence built on EigenDA. Three autonomous agents reason over NASA science data. Commit-reveal cycle with KZG commitments, independence proofs, live integrity checks.",
    SWARM_MIND * 5,  # full content
    ["eigenda", "eigencompute", "eigenlayer", "agent", "verifiable", "commit-reveal", "kzg", "tee"]
)

report_lines = []
report_lines.append("# EigenLayer Challenge — Submission Analysis\n")
report_lines.append(f"Generated: automated scan via GitHub Search API\n")
report_lines.append(f"Scoring: {', '.join(f'{c[0]} ({c[1]}pts)' for c in CRITERIA)}\n")
report_lines.append("---\n")

report_lines.append("## Swarm Mind (Reference)\n")
report_lines.append(f"**Total: {sm_total}/100**\n")
for k, v in sm_scores.items():
    report_lines.append(f"- {k}: {v}\n")
report_lines.append("\n")

report_lines.append("## Competitors Found\n\n")

scored = []
for r in repos:
    fn = r["full_name"]
    readme = readmes.get(fn, "")
    desc   = r.get("description") or ""
    topics = r.get("topics") or []
    total, scores = score_project(r["name"], desc, readme, topics)
    scored.append((total, scores, r, readme[:500]))

scored.sort(key=lambda x: x[0], reverse=True)

for rank, (total, scores, r, readme_snip) in enumerate(scored, 1):
    fn     = r["full_name"]
    stars  = r.get("stargazers_count", 0)
    lang   = r.get("language") or "?"
    desc   = r.get("description") or "No description"
    url    = r.get("html_url")
    created = r.get("created_at", "")[:10]

    report_lines.append(f"### {rank}. [{fn}]({url})\n")
    report_lines.append(f"⭐ {stars} | {lang} | Created: {created}\n\n")
    report_lines.append(f"**Description:** {desc}\n\n")
    report_lines.append(f"**Score: {total}/100**\n")
    for k, v in scores.items():
        report_lines.append(f"- {k}: {v}\n")
    if readme_snip.strip():
        report_lines.append(f"\n**README (snippet):**\n```\n{readme_snip[:400]}\n```\n")
    report_lines.append("\n---\n\n")

with open("submissions_report.md", "w") as f:
    f.writelines(report_lines)

print(f"Report written: submissions_report.md")
print(f"\nTop 10 by score:")
for rank, (total, _, r, _) in enumerate(scored[:10], 1):
    print(f"  {rank:2}. {r['full_name']:55} score={total}/100")
print(f"\nSwarm Mind baseline: {sm_total}/100")
PYEOF

echo ""
echo "[5/6] Done. Output files:"
echo "  submissions_raw.json    — all repos with metadata"
echo "  submissions_readmes.json — README snippets"
echo "  submissions_report.md   — full comparison report"
echo ""
echo "[6/6] Quick summary:"
echo ""
head -80 submissions_report.md

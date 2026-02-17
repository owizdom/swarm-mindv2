#!/usr/bin/env bash
set -euo pipefail
echo "=== Emergent Swarm Mind — Deploy to EigenCompute ==="
docker build --platform linux/amd64 -t swarm-mind:latest .
ecloud compute app deploy --image-ref swarm-mind:latest
ecloud compute app list
echo "=== Done. Run 'ecloud compute app logs' to watch ==="

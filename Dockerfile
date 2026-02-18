# ── Build stage ──
FROM node:22-slim AS builder
WORKDIR /app

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY agents/ ./agents/
COPY dashboard/ ./dashboard/
RUN npm run build

# ── Runtime stage ──
FROM node:22-slim AS runtime
WORKDIR /app

# Copy compiled JS + node_modules (includes pre-built native binaries)
COPY --from=builder /app/dist         ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY dashboard/index.html             ./dashboard/index.html

VOLUME ["/data"]
EXPOSE 3001
CMD ["node", "dist/agents/runner.js"]

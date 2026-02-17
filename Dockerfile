FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY agents/ ./agents/
COPY dashboard/ ./dashboard/
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY dashboard/index.html ./dashboard/
EXPOSE 3000
CMD ["node", "dist/agents/swarm.js"]

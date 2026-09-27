# Arc Rep — Production Dockerfile
#
# Two-process model:
#   1. Express API server (bun, port 3001)
#   2. Static frontend served by serve (port 8080)
#
# start.sh supervises both, restarts the API on crash, and
# exposes a single health endpoint.
#
# Build:
#   docker build -t arc-rep .
#
# Run (minimum required env):
#   docker run -p 8080:8080 -p 3001:3001 \
#     -e RPC_PROXY_BASE_URL=... \
#     -e RPC_PROXY_TOKEN=... \
#     -e RPC_PROXY_CHAINS=Arc_Testnet \
#     arc-rep
#
# Optional (enables Goldsky historical provider):
#   -e GOLDSKY_POSTGRES_URL=postgresql://...
#
# See .env.example for the full variable list.

FROM oven/bun:1.2-slim AS base
WORKDIR /app

# ── Install dependencies ──────────────────────────────────────────────────────
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production=false

# ── Build frontend ────────────────────────────────────────────────────────────
FROM deps AS builder
COPY . .
RUN bun run build

# ── Production image ──────────────────────────────────────────────────────────
FROM oven/bun:1.2-slim AS production
WORKDIR /app

# Copy only what the runtime needs
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/start.sh ./start.sh

# Make the startup script executable
RUN chmod +x /app/start.sh

# Install `serve` for the static frontend
RUN bun add -g serve 2>/dev/null || true

# Non-root user
RUN addgroup --system arcgrp && adduser --system --ingroup arcgrp arcuser
RUN chown -R arcuser:arcgrp /app
USER arcuser

# Frontend static assets (port 8080) and API (port 3001)
EXPOSE 8080 3001

# Healthcheck — uses the API health endpoint
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://localhost:3001/health'); process.exit(r.ok ? 0 : 1);"

CMD ["/app/start.sh"]

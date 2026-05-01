# MemFlow — Multi-stage build: Bun app + Memgraph
#
# Stage 1: Build the app with oven/bun (fast install, native TS)
# Stage 2: Runtime with Memgraph + Bun binary

# ---------------------------------------------------------------------------
# Stage 1: Install dependencies with oven/bun
# ---------------------------------------------------------------------------
FROM oven/bun:1 AS builder

WORKDIR /build

# Copy package files first for better layer caching
COPY package.json bun.lockb* ./

# Install production dependencies only (no devDependencies)
RUN bun install --frozen-lockfile --production 2>/dev/null || bun install --production

# Copy source and config
COPY src ./src
COPY tsconfig.json ./

# Type-check (optional — can be removed for faster builds)
# RUN bun run typecheck

# ---------------------------------------------------------------------------
# Stage 2: Runtime — Memgraph + Bun
# ---------------------------------------------------------------------------
FROM memgraph/memgraph-mage:2.19.0

# Install Bun from the builder stage's binary (faster than curl)
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=oven/bun:1 /usr/local/bin/bunx /usr/local/bin/bunx

# Install minimal runtime deps (nc for entrypoint health checks)
RUN apt-get update && apt-get install -y \
    curl \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy installed deps from builder
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./

# Copy source (Bun runs .ts directly — no build step needed!)
COPY src ./src
COPY tsconfig.json ./
COPY docs ./docs
COPY README.md ARCHITECTURE.md ./

# Copy entrypoint
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose Memgraph Bolt (7687) + MemFlow HTTP (3000)
EXPOSE 7687 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "run", "start"]

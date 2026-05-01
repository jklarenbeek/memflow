# MemFlow - Single Container: Memgraph + MAGE + Bun
FROM memgraph/memgraph-mage:2.19.0

# Install system deps for Bun
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

# Copy package files first for better caching
COPY package.json bun.lockb* ./

# Install deps (production only)
RUN bun install --frozen-lockfile --production 2>/dev/null || bun install --production

# Copy source
COPY src ./src
COPY tsconfig.json ./
COPY docs ./docs
COPY README.md ARCHITECTURE.md ./

# Build TypeScript
RUN bun run build

# Copy entrypoint
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose Memgraph Bolt (7687) + MemFlow HTTP (3000)
EXPOSE 7687 3000

# Healthcheck — now actually works (HTTP server exists)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "run", "start"]

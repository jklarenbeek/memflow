#!/bin/bash
set -e

# Start Memgraph in background (base image includes it)
echo "[entrypoint] Starting Memgraph..."
memgraph --storage-mode=IN_MEMORY_ANALYTICAL --log-level=WARNING &
MEMGRAPH_PID=$!

# Wait for Memgraph Bolt port
echo "[entrypoint] Waiting for Memgraph on port 7687..."
for i in $(seq 1 30); do
  if nc -z localhost 7687 2>/dev/null; then
    echo "[entrypoint] Memgraph ready."
    break
  fi
  sleep 1
done

# Start MemFlow
echo "[entrypoint] Starting MemFlow..."
exec "$@"

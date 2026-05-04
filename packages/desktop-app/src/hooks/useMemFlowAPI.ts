/**
 * useMemFlowAPI — React hook wrapping the MemFlow API client
 */
import { useState, useCallback, useEffect } from "react";
import { api } from "../lib/api";
import { useAppStore } from "../stores/appStore";
import { useSidecarStore } from "../stores/sidecarStore";

export function useMemFlowAPI() {
  const serverUrl = useAppStore((s) => s.serverUrl);

  // Sync API base URL with store
  useEffect(() => {
    api.setBaseUrl(serverUrl);
  }, [serverUrl]);

  return api;
}

/** Health polling hook — checks /health every `interval` ms */
export function useHealthPoller(interval = 5000) {
  const serverUrl = useAppStore((s) => s.serverUrl);
  const { setHealth, setDisconnected, setStatus } = useSidecarStore();

  useEffect(() => {
    api.setBaseUrl(serverUrl);

    const checkHealth = async () => {
      try {
        const data = await api.health();
        setHealth(
          {
            memgraph: data.checks.memgraph as "connected" | "disconnected",
            ollama: data.checks.ollama as "reachable" | "unreachable",
            tavily: data.checks.tavily as "configured" | "missing",
          },
          data.version,
          data.modules.length,
        );
      } catch {
        setDisconnected();
      }
    };

    // Initial check
    setStatus("starting");
    checkHealth();

    // Periodic polling
    const id = setInterval(checkHealth, interval);
    return () => clearInterval(id);
  }, [serverUrl, interval]);
}

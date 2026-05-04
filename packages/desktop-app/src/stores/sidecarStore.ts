/**
 * Sidecar Store — MemFlow backend connection state
 */
import { create } from "zustand";

export interface HealthCheck {
  memgraph: "connected" | "disconnected";
  ollama: "reachable" | "unreachable";
  tavily: "configured" | "missing";
}

export interface SidecarState {
  status: "starting" | "healthy" | "degraded" | "disconnected" | "error";
  serverUrl: string;
  version: string | null;
  moduleCount: number;
  health: HealthCheck | null;
  lastChecked: string | null;

  setStatus: (status: SidecarState["status"]) => void;
  setServerUrl: (url: string) => void;
  setHealth: (health: HealthCheck, version: string, moduleCount: number) => void;
  setDisconnected: () => void;
}

export const useSidecarStore = create<SidecarState>()((set) => ({
  status: "disconnected",
  serverUrl: "http://127.0.0.1:3000",
  version: null,
  moduleCount: 0,
  health: null,
  lastChecked: null,

  setStatus: (status) => set({ status }),
  setServerUrl: (url) => set({ serverUrl: url }),
  setHealth: (health, version, moduleCount) =>
    set({
      health,
      version,
      moduleCount,
      status: health.memgraph === "connected" ? "healthy" : "degraded",
      lastChecked: new Date().toISOString(),
    }),
  setDisconnected: () => set({ status: "disconnected", health: null, lastChecked: new Date().toISOString() }),
}));

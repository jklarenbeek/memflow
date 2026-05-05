/**
 * App Store — Global application state
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AppTab = "chat" | "dag" | "graph" | "ingestion";

export interface AppState {
  currentSolutionId: string | null;
  currentConversationId: string | null;
  theme: "dark" | "light";
  sidebarCollapsed: boolean;
  serverUrl: string;
  connectionMode: "sidecar" | "external";
  hasCompletedOnboarding: boolean;
  activeTab: AppTab;

  setCurrentSolution: (id: string | null) => void;
  setCurrentConversation: (id: string | null) => void;
  setTheme: (theme: "dark" | "light") => void;
  toggleSidebar: () => void;
  setServerUrl: (url: string) => void;
  setConnectionMode: (mode: "sidecar" | "external") => void;
  setOnboardingComplete: () => void;
  setActiveTab: (tab: AppTab) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      currentSolutionId: null,
      currentConversationId: null,
      theme: "dark",
      sidebarCollapsed: false,
      serverUrl: "http://127.0.0.1:3000",
      connectionMode: "sidecar",
      hasCompletedOnboarding: false,
      activeTab: "chat",

      setCurrentSolution: (id) => set({ currentSolutionId: id, currentConversationId: null }),
      setCurrentConversation: (id) => set({ currentConversationId: id }),
      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setServerUrl: (url) => set({ serverUrl: url }),
      setConnectionMode: (mode) => set({ connectionMode: mode }),
      setOnboardingComplete: () => set({ hasCompletedOnboarding: true }),
      setActiveTab: (tab) => set({ activeTab: tab }),
    }),
    { name: "memflow-app-store" },
  ),
);

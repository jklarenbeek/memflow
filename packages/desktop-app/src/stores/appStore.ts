/**
 * App Store — Global application state
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface AppState {
  currentSolutionId: string | null;
  currentConversationId: string | null;
  theme: "dark" | "light";
  sidebarCollapsed: boolean;
  serverUrl: string;
  connectionMode: "sidecar" | "external";
  hasCompletedOnboarding: boolean;

  setCurrentSolution: (id: string | null) => void;
  setCurrentConversation: (id: string | null) => void;
  setTheme: (theme: "dark" | "light") => void;
  toggleSidebar: () => void;
  setServerUrl: (url: string) => void;
  setConnectionMode: (mode: "sidecar" | "external") => void;
  setOnboardingComplete: () => void;
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

      setCurrentSolution: (id) => set({ currentSolutionId: id, currentConversationId: null }),
      setCurrentConversation: (id) => set({ currentConversationId: id }),
      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setServerUrl: (url) => set({ serverUrl: url }),
      setConnectionMode: (mode) => set({ connectionMode: mode }),
      setOnboardingComplete: () => set({ hasCompletedOnboarding: true }),
    }),
    { name: "memflow-app-store" },
  ),
);

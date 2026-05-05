/**
 * Ingestion Store — Persistent file queue state
 *
 * Manages the file ingestion queue with per-file status tracking.
 * Persisted via Zustand to survive tab switches.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface IngestionFile {
  id: string;
  name: string;
  size: number;
  type: string;
  status: "queued" | "uploading" | "processing" | "complete" | "error";
  progress: number;
  currentStage?: string;
  result?: { chunks: number; entities: number; memories: number };
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface IngestionState {
  files: IngestionFile[];
  isDropActive: boolean;

  addFile: (file: IngestionFile) => void;
  updateFile: (id: string, update: Partial<IngestionFile>) => void;
  removeFile: (id: string) => void;
  clearCompleted: () => void;
  setDropActive: (active: boolean) => void;
  getTotals: () => { chunks: number; entities: number; memories: number };
}

export const useIngestionStore = create<IngestionState>()(
  persist(
    (set, get) => ({
      files: [],
      isDropActive: false,

      addFile: (file) => {
        set((s) => ({ files: [file, ...s.files] }));
      },

      updateFile: (id, update) => {
        set((s) => ({
          files: s.files.map((f) => (f.id === id ? { ...f, ...update } : f)),
        }));
      },

      removeFile: (id) => {
        set((s) => ({ files: s.files.filter((f) => f.id !== id) }));
      },

      clearCompleted: () => {
        set((s) => ({
          files: s.files.filter((f) => f.status !== "complete" && f.status !== "error"),
        }));
      },

      setDropActive: (active) => set({ isDropActive: active }),

      getTotals: () => {
        const { files } = get();
        return files
          .filter((f) => f.status === "complete" && f.result)
          .reduce(
            (acc, f) => ({
              chunks: acc.chunks + (f.result?.chunks ?? 0),
              entities: acc.entities + (f.result?.entities ?? 0),
              memories: acc.memories + (f.result?.memories ?? 0),
            }),
            { chunks: 0, entities: 0, memories: 0 },
          );
      },
    }),
    {
      name: "memflow-ingestion-store",
      // Only persist the files array, not transient state
      partialize: (state) => ({ files: state.files }),
    },
  ),
);

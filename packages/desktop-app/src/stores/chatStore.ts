/**
 * Chat Store — Conversation message state and streaming
 */
import { create } from "zustand";

export interface StageStatus {
  id: string;
  module: string;
  status: "pending" | "running" | "complete" | "error";
  durationMs?: number;
  error?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  workflowId?: string;
  workflowName?: string;
  stages?: StageStatus[];
  currentStageId?: string;
  stageTrace?: { stageId: string; module: string; durationMs: number; status: string }[];
  sources?: string[];
  durationMs?: number;
  tokenUsage?: number;
  isStreaming?: boolean;
  collapsed?: boolean;
  createdAt: string;
}

export interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingTokens: string;
  error: string | null;

  addMessage: (msg: ChatMessage) => void;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  setMessages: (msgs: ChatMessage[]) => void;
  clearMessages: () => void;
  setStreaming: (streaming: boolean) => void;
  appendToken: (token: string) => void;
  resetTokens: () => void;
  setError: (error: string | null) => void;
}

export const useChatStore = create<ChatState>()((set) => ({
  messages: [],
  isStreaming: false,
  streamingTokens: "",
  error: null,

  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  updateMessage: (id, updates) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...updates } : m)),
    })),
  setMessages: (msgs) => set({ messages: msgs }),
  clearMessages: () => set({ messages: [], streamingTokens: "", error: null }),
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  appendToken: (token) => set((s) => ({ streamingTokens: s.streamingTokens + token })),
  resetTokens: () => set({ streamingTokens: "" }),
  setError: (error) => set({ error }),
}));

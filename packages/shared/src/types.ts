/**
 * @memflow/shared — Response Types
 *
 * TypeScript interfaces for API response contracts.
 * Provides a single source of truth for shape of data
 * exchanged between the desktop frontend and backend.
 */

// -------------------------------------------------------------------------
// Stage Status — shared between DAG, chat, and execution views
// -------------------------------------------------------------------------
export type StageStatus = "pending" | "running" | "complete" | "error";

// -------------------------------------------------------------------------
// API Response Wrappers
// -------------------------------------------------------------------------
export interface ApiResponse<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

export interface PaginatedResponse<T = unknown> extends ApiResponse<T[]> {
  count: number;
  offset?: number;
  limit?: number;
}

// -------------------------------------------------------------------------
// Solution
// -------------------------------------------------------------------------
export interface Solution {
  id: string;
  name: string;
  domain: string;
  createdAt: string;
  updatedAt: string;
  stats?: {
    entityCount: number;
    memoryCount: number;
    conversationCount: number;
  };
}

// -------------------------------------------------------------------------
// Conversation & Message
// -------------------------------------------------------------------------
export interface Conversation {
  id: string;
  solutionId: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview?: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  workflowName?: string;
  stageTrace?: StageTraceEntry[];
  tokenUsage?: number;
  durationMs?: number;
  createdAt: string;
}

export interface StageTraceEntry {
  id: string;
  module: string;
  status: StageStatus;
  durationMs?: number;
  outputPreview?: string;
  error?: string;
}

// -------------------------------------------------------------------------
// Execution
// -------------------------------------------------------------------------
export interface Execution {
  id: string;
  solutionId: string;
  conversationId?: string;
  workflowName: string;
  status: "running" | "complete" | "error";
  stageTrace?: StageTraceEntry[];
  state?: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

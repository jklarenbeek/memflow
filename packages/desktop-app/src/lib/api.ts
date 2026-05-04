/**
 * MemFlow API Client — typed fetch wrapper for all REST endpoints
 */

export class MemFlowAPI {
  constructor(private baseUrl: string) {}

  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/$/, "");
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", ...options?.headers },
      ...options,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // Health
  async health() {
    return this.request<{
      status: string; service: string; version: string;
      modules: string[]; checks: Record<string, string>;
    }>("/health");
  }

  // Solutions
  async createSolution(data: { name: string; description?: string; domain?: string }) {
    return this.request<{ success: boolean; solution: Record<string, unknown> }>(
      "/api/v1/solutions", { method: "POST", body: JSON.stringify(data) });
  }

  async listSolutions() {
    return this.request<{ success: boolean; solutions: Record<string, unknown>[]; count: number }>(
      "/api/v1/solutions");
  }

  async getSolution(id: string) {
    return this.request<{ success: boolean; solution: Record<string, unknown> }>(
      `/api/v1/solutions/${id}`);
  }

  async updateSolution(id: string, data: Record<string, unknown>) {
    return this.request<{ success: boolean; solution: Record<string, unknown> }>(
      `/api/v1/solutions/${id}`, { method: "PATCH", body: JSON.stringify(data) });
  }

  async deleteSolution(id: string) {
    return this.request<{ success: boolean }>(`/api/v1/solutions/${id}`, { method: "DELETE" });
  }

  // Conversations
  async createConversation(data: { solutionId: string; title?: string; workflowName?: string }) {
    return this.request<{ success: boolean; conversation: Record<string, unknown> }>(
      "/api/v1/conversations", { method: "POST", body: JSON.stringify(data) });
  }

  async listConversations(solutionId?: string) {
    const q = solutionId ? `?solutionId=${solutionId}` : "";
    return this.request<{ success: boolean; conversations: Record<string, unknown>[] }>(
      `/api/v1/conversations${q}`);
  }

  async getConversation(id: string) {
    return this.request<{ success: boolean; conversation: Record<string, unknown>; messages: Record<string, unknown>[] }>(
      `/api/v1/conversations/${id}`);
  }

  async addMessage(conversationId: string, data: { role: string; content: string; workflowId?: string; workflowName?: string }) {
    return this.request<{ success: boolean; message: Record<string, unknown> }>(
      `/api/v1/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify(data) });
  }

  async updateMessage(conversationId: string, messageId: string, data: Record<string, unknown>) {
    return this.request<{ success: boolean; message: Record<string, unknown> }>(
      `/api/v1/conversations/${conversationId}/messages/${messageId}`,
      { method: "PATCH", body: JSON.stringify(data) });
  }

  // Workflow catalog
  async listWorkflows() {
    return this.request<{ success: boolean; workflows: Record<string, unknown>[]; count: number }>(
      "/api/v1/workflows/catalog");
  }

  async getWorkflow(name: string) {
    return this.request<{ success: boolean; workflow: Record<string, unknown> }>(
      `/api/v1/workflows/catalog/${name}`);
  }

  // Search / Recall
  async search(query: string, tenantId?: string) {
    return this.request<{ success: boolean; chunks: unknown[]; memories: unknown[] }>(
      "/api/v1/search", { method: "POST", body: JSON.stringify({ query, tenantId }) });
  }

  async recall(query: string, tenantId?: string) {
    return this.request<{ success: boolean; answer: string; sources: string[] }>(
      "/api/v1/recall", { method: "POST", body: JSON.stringify({ query, tenantId }) });
  }

  // Migration
  async runMigration() {
    return this.request<{ success: boolean; migratedNodes: number; defaultSolutionId?: string }>(
      "/api/v1/migrate", { method: "POST" });
  }

  async getMigrationStatus() {
    return this.request<{ success: boolean; migrations: unknown[]; orphanedNodes: number }>(
      "/api/v1/migrate/status");
  }

  // Streaming workflow execution (returns EventSource URL info)
  getStreamUrl() {
    return `${this.baseUrl}/workflow/run/stream`;
  }
}

// Singleton instance
export const api = new MemFlowAPI("http://127.0.0.1:3000");

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

  // ---------------------------------------------------------------------------
  // Phase 2: Module Introspection
  // ---------------------------------------------------------------------------

  async listModuleSchemas() {
    return this.request<{
      success: boolean;
      modules: Array<{ name: string; version: string; schema: Record<string, unknown> }>;
    }>("/api/v1/modules/schemas");
  }

  async getModuleSchema(name: string) {
    return this.request<{
      success: boolean;
      module: { name: string; version: string; schema: Record<string, unknown> };
    }>(`/api/v1/modules/schemas/${name}`);
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Execution History
  // ---------------------------------------------------------------------------

  async listExecutions(limit = 20) {
    return this.request<{
      success: boolean;
      executions: Record<string, unknown>[];
      count: number;
    }>(`/api/v1/executions?limit=${limit}`);
  }

  async getExecution(id: string) {
    return this.request<{
      success: boolean;
      execution: Record<string, unknown>;
    }>(`/api/v1/executions/${id}`);
  }

  async createExecution(data: Record<string, unknown>) {
    return this.request<{ success: boolean; execution: Record<string, unknown> }>(
      "/api/v1/executions",
      { method: "POST", body: JSON.stringify(data) },
    );
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Graph Explorer
  // ---------------------------------------------------------------------------

  async graphNeighbors(nodeId: string, depth = 1) {
    return this.request<{
      success: boolean;
      nodes: Record<string, unknown>[];
      relationships: Record<string, unknown>[];
    }>(`/api/v1/graph/neighbors/${encodeURIComponent(nodeId)}?depth=${depth}`);
  }

  async graphSubgraph(nodeIds: string[], maxDepth = 2) {
    return this.request<{
      success: boolean;
      nodes: Record<string, unknown>[];
      relationships: Record<string, unknown>[];
    }>("/api/v1/graph/subgraph", {
      method: "POST",
      body: JSON.stringify({ nodeIds, maxDepth }),
    });
  }

  async graphCommunities(limit = 10) {
    return this.request<{
      success: boolean;
      communities: Record<string, unknown>[];
    }>(`/api/v1/graph/communities?limit=${limit}`);
  }

  async graphTimeline(since?: string, until?: string) {
    const params = new URLSearchParams();
    if (since) params.set("since", since);
    if (until) params.set("until", until);
    return this.request<{
      success: boolean;
      timeline: Record<string, unknown>[];
    }>(`/api/v1/graph/timeline?${params}`);
  }

  async graphStats() {
    return this.request<{
      success: boolean;
      stats: Record<string, unknown>;
    }>("/api/v1/graph/stats");
  }

  // ---------------------------------------------------------------------------
  // Phase 2: GMPL Patterns
  // ---------------------------------------------------------------------------

  async listPatterns() {
    return this.request<{
      success: boolean;
      patterns: Record<string, unknown>[];
    }>("/api/v1/gmpl/patterns");
  }

  async listRoles() {
    return this.request<{
      success: boolean;
      roles: Record<string, unknown>[];
    }>("/api/v1/gmpl/roles");
  }
}

// Singleton instance
export const api = new MemFlowAPI("http://127.0.0.1:3000");

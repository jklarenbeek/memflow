/**
 * MemFlow API Client — typed fetch wrapper for all REST endpoints
 */

// ---------------------------------------------------------------------------
// Shared Types
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  labels: string[];
  [key: string]: unknown;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
}

export interface GraphNeighbor {
  node: GraphNode;
  edge: string;
  direction: "incoming" | "outgoing";
}

export interface CommunityData {
  id: string;
  memberCount: number;
  topEntities: string[];
  [key: string]: unknown;
}

export interface TimelineEntry {
  label: string;
  date: string;
  count: number;
}

export interface GraphStatsData {
  nodeCounts: Array<{ label: string; count: number }>;
  relationCounts: Array<{ type: string; count: number }>;
  entityTypes: Array<{ type: string; count: number }>;
}

export interface SubgraphFilters {
  labels?: string[];
  timeRange?: { from?: string; to?: string };
  community?: string;
  solutionId?: string;
}

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
  // Phase 2: Graph Explorer — aligned with graphExplorer.ts server responses
  // ---------------------------------------------------------------------------

  async graphNeighbors(nodeId: string, depth = 1, limit = 50) {
    return this.request<{
      success: boolean;
      node: GraphNode;
      neighbors: GraphNeighbor[];
    }>(`/api/v1/graph/neighbors/${encodeURIComponent(nodeId)}?depth=${depth}&limit=${limit}`);
  }

  async graphSubgraph(nodeIds: string[], maxDepth = 2, filters?: SubgraphFilters) {
    return this.request<{
      success: boolean;
      nodes: GraphNode[];
      edges: GraphEdge[];
    }>("/api/v1/graph/subgraph", {
      method: "POST",
      body: JSON.stringify({ nodeIds, maxDepth, filters }),
    });
  }

  async graphCommunities(solutionId?: string, limit = 50) {
    const params = new URLSearchParams();
    if (solutionId) params.set("solutionId", solutionId);
    params.set("limit", String(limit));
    return this.request<{
      success: boolean;
      communities: CommunityData[];
      count: number;
    }>(`/api/v1/graph/communities?${params}`);
  }

  async graphTimeline(solutionId?: string, from?: string, to?: string) {
    const params = new URLSearchParams();
    if (solutionId) params.set("solutionId", solutionId);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return this.request<{
      success: boolean;
      timeline: TimelineEntry[];
    }>(`/api/v1/graph/timeline?${params}`);
  }

  async graphStats(solutionId?: string) {
    const params = new URLSearchParams();
    if (solutionId) params.set("solutionId", solutionId);
    return this.request<{
      success: boolean;
    } & GraphStatsData>(`/api/v1/graph/stats?${params}`);
  }

  async graphNodes(solutionId?: string, label?: string, limit = 20) {
    const params = new URLSearchParams();
    if (solutionId) params.set("solutionId", solutionId);
    if (label) params.set("label", label);
    params.set("limit", String(limit));
    return this.request<{
      success: boolean;
      nodes: GraphNode[];
    }>(`/api/v1/graph/nodes?${params}`);
  }

  // ---------------------------------------------------------------------------
  // Phase 2: GMPL Patterns
  // ---------------------------------------------------------------------------

  async listPatterns() {
    return this.request<{
      success: boolean;
      patterns: Array<{
        id: string;
        version?: string;
        description: string;
        workflowRef?: string;
        requiredRoles: string[];
        observabilityEvents?: string[];
        hasConfigSchema: boolean;
      }>;
      count: number;
    }>("/api/v1/gmpl/patterns");
  }

  async listRoles() {
    return this.request<{
      success: boolean;
      roles: Array<{
        id: string;
        description: string;
        persona: string;
        promptPack?: string | null;
        requiredModules?: string[];
        base?: string | null;
      }>;
      count: number;
    }>("/api/v1/gmpl/roles");
  }

  // ---------------------------------------------------------------------------
  // Phase 2: File Ingestion
  // ---------------------------------------------------------------------------

  async ingestFile(file: File, solutionId: string, skipMemory = false) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("solutionId", solutionId);
    if (skipMemory) formData.append("skipMemory", "true");
    const url = `${this.baseUrl}/api/v1/ingest`;
    const res = await fetch(url, { method: "POST", body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json() as Promise<{
      success: boolean;
      ingestionId: string;
      filename: string;
      format: string;
      parserModule: string;
      solutionId: string;
      workflow: Record<string, unknown>;
      streamUrl: string;
      tempFilePath?: string;
    }>;
  }

  async ingestFilePath(filePath: string, solutionId: string, format?: string) {
    return this.request<{
      success: boolean;
      ingestionId: string;
      filename: string;
      format: string;
      parserModule: string;
      solutionId: string;
      workflow: Record<string, unknown>;
      streamUrl: string;
    }>("/api/v1/ingest", {
      method: "POST",
      body: JSON.stringify({ filePath, solutionId, format }),
    });
  }
}

// Singleton instance
export const api = new MemFlowAPI("http://127.0.0.1:3000");

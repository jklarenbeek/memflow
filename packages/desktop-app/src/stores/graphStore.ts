/**
 * Graph Store — Knowledge graph exploration state
 *
 * Manages graph data, selection, filters, and community data
 * for the Graph Explorer tab. Uses the api singleton for data fetching.
 */
import { create } from "zustand";
import { api, type GraphNode, type GraphEdge, type CommunityData, type TimelineEntry, type GraphStatsData } from "../lib/api";

export interface GraphFilters {
  labels: string[];
  solutionId: string | null;
  timeRange: { from?: string; to?: string };
  communityId: string | null;
  searchQuery: string;
}

export interface GraphState {
  // Data
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: CommunityData[];
  stats: GraphStatsData | null;
  timeline: TimelineEntry[];

  // Selection & Interaction
  selectedNodeId: string | null;
  selectedNodeData: GraphNode | null;
  expandedNodeIds: Set<string>;

  // Filters
  filters: GraphFilters;

  // UI State
  loading: boolean;
  error: string | null;
  detailsPanelOpen: boolean;
  communityPanelOpen: boolean;

  // Actions
  loadInitialGraph: (solutionId?: string) => Promise<void>;
  loadFullGraph: (solutionId?: string) => Promise<void>;
  expandNode: (nodeId: string) => Promise<void>;
  mergeSubgraph: (nodes: GraphNode[], edges: GraphEdge[]) => void;
  setSelectedNode: (nodeId: string | null) => void;
  setFilters: (filters: Partial<GraphFilters>) => void;
  loadCommunities: (solutionId?: string) => Promise<void>;
  loadStats: (solutionId?: string) => Promise<void>;
  loadTimeline: (solutionId?: string) => Promise<void>;
  toggleCommunityPanel: () => void;
  clearGraph: () => void;
}

const DEFAULT_FILTERS: GraphFilters = {
  labels: [],
  solutionId: null,
  timeRange: {},
  communityId: null,
  searchQuery: "",
};

/**
 * Deduplicate nodes by id, keeping the first occurrence
 */
function deduplicateNodes(nodes: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  return nodes.filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
}

/**
 * Deduplicate edges by source+target+type triple
 */
function deduplicateEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.source}:${e.target}:${e.type}`;
    const reverseKey = `${e.target}:${e.source}:${e.type}`;
    if (seen.has(key) || seen.has(reverseKey)) return false;
    seen.add(key);
    return true;
  });
}

export const useGraphStore = create<GraphState>()((set, get) => ({
  nodes: [],
  edges: [],
  communities: [],
  stats: null,
  timeline: [],
  selectedNodeId: null,
  selectedNodeData: null,
  expandedNodeIds: new Set(),
  filters: { ...DEFAULT_FILTERS },
  loading: false,
  error: null,
  detailsPanelOpen: false,
  communityPanelOpen: false,

  loadInitialGraph: async (solutionId?: string) => {
    set({ loading: true, error: null });
    try {
      // Load stats first to understand the graph size
      const statsRes = await api.graphStats(solutionId);
      const totalNodes = statsRes.nodeCounts.reduce((sum, c) => sum + c.count, 0);

      // Load communities for context
      const commRes = await api.graphCommunities(solutionId, 50);

      // Load initial subgraph: start from community nodes + top entities
      // If graph is small enough (< 200 nodes), load all via a broad query
      let nodes: GraphNode[] = [];
      let edges: GraphEdge[] = [];

      if (totalNodes <= 200 && totalNodes > 0) {
        // Small graph — load everything via a community-seed expansion
        const seedIds = commRes.communities
          .filter((c) => c.id)
          .map((c) => c.id as string)
          .slice(0, 10);

        if (seedIds.length > 0) {
          const subRes = await api.graphSubgraph(seedIds, 3, {
            solutionId: solutionId ?? undefined,
          });
          nodes = subRes.nodes;
          edges = subRes.edges;
        }
      } else if (totalNodes > 200) {
        // Large graph — load top communities only as seeds
        const seedIds = commRes.communities
          .filter((c) => c.id)
          .map((c) => c.id as string)
          .slice(0, 5);

        if (seedIds.length > 0) {
          const subRes = await api.graphSubgraph(seedIds, 1, {
            solutionId: solutionId ?? undefined,
          });
          nodes = subRes.nodes.slice(0, 200);
          edges = subRes.edges;
        }
      }

      set({
        nodes: deduplicateNodes(nodes),
        edges: deduplicateEdges(edges),
        communities: commRes.communities,
        stats: {
          nodeCounts: statsRes.nodeCounts,
          relationCounts: statsRes.relationCounts,
          entityTypes: statsRes.entityTypes,
        },
        loading: false,
        expandedNodeIds: new Set(),
        filters: { ...DEFAULT_FILTERS, solutionId: solutionId ?? null },
      });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  loadFullGraph: async (solutionId?: string) => {
    set({ loading: true, error: null });
    try {
      // Get all communities as seed nodes
      const commRes = await api.graphCommunities(solutionId, 200);
      const seedIds = commRes.communities
        .filter((c) => c.id)
        .map((c) => c.id as string);

      let nodes: GraphNode[] = [];
      let edges: GraphEdge[] = [];

      if (seedIds.length > 0) {
        const subRes = await api.graphSubgraph(seedIds, 5, {
          solutionId: solutionId ?? undefined,
        });
        nodes = subRes.nodes;
        edges = subRes.edges;
      }

      set({
        nodes: deduplicateNodes(nodes),
        edges: deduplicateEdges(edges),
        communities: commRes.communities,
        loading: false,
        expandedNodeIds: new Set(),
      });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  expandNode: async (nodeId: string) => {
    const { expandedNodeIds, nodes, edges } = get();
    if (expandedNodeIds.has(nodeId)) return;

    try {
      const res = await api.graphNeighbors(nodeId, 1, 50);
      const newNodes: GraphNode[] = res.neighbors.map((n) => n.node);
      const newEdges: GraphEdge[] = res.neighbors.map((n) => ({
        source: n.direction === "outgoing" ? nodeId : n.node.id,
        target: n.direction === "outgoing" ? n.node.id : nodeId,
        type: n.edge,
      }));

      const updated = new Set(expandedNodeIds);
      updated.add(nodeId);

      set({
        nodes: deduplicateNodes([...nodes, ...newNodes]),
        edges: deduplicateEdges([...edges, ...newEdges]),
        expandedNodeIds: updated,
      });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  mergeSubgraph: (newNodes, newEdges) => {
    const { nodes, edges } = get();
    set({
      nodes: deduplicateNodes([...nodes, ...newNodes]),
      edges: deduplicateEdges([...edges, ...newEdges]),
    });
  },

  setSelectedNode: (nodeId) => {
    const { nodes } = get();
    const nodeData = nodeId ? nodes.find((n) => n.id === nodeId) ?? null : null;
    set({
      selectedNodeId: nodeId,
      selectedNodeData: nodeData,
      detailsPanelOpen: !!nodeId,
    });
  },

  setFilters: (updates) => {
    const { filters } = get();
    set({ filters: { ...filters, ...updates } });
  },

  loadCommunities: async (solutionId?: string) => {
    try {
      const res = await api.graphCommunities(solutionId, 50);
      set({ communities: res.communities });
    } catch (err) {
      console.error("Failed to load communities:", err);
    }
  },

  loadStats: async (solutionId?: string) => {
    try {
      const res = await api.graphStats(solutionId);
      set({
        stats: {
          nodeCounts: res.nodeCounts,
          relationCounts: res.relationCounts,
          entityTypes: res.entityTypes,
        },
      });
    } catch (err) {
      console.error("Failed to load stats:", err);
    }
  },

  loadTimeline: async (solutionId?: string) => {
    try {
      const res = await api.graphTimeline(solutionId);
      set({ timeline: res.timeline });
    } catch (err) {
      console.error("Failed to load timeline:", err);
    }
  },

  toggleCommunityPanel: () => {
    set((s) => ({ communityPanelOpen: !s.communityPanelOpen }));
  },

  clearGraph: () => {
    set({
      nodes: [],
      edges: [],
      communities: [],
      stats: null,
      timeline: [],
      selectedNodeId: null,
      selectedNodeData: null,
      expandedNodeIds: new Set(),
      filters: { ...DEFAULT_FILTERS },
      loading: false,
      error: null,
      detailsPanelOpen: false,
      communityPanelOpen: false,
    });
  },
}));

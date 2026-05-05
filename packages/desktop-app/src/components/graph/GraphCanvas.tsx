/**
 * GraphCanvas — Memgraph Orb graph renderer
 *
 * Uses @memgraph/orb Canvas 2D renderer with d3-force layout.
 * Handles node/edge rendering, interactions, and live updates.
 */
import { useEffect, useRef, useCallback } from "react";
import { Orb, OrbEventType } from "@memgraph/orb";
import type { INodeBase, IEdgeBase } from "@memgraph/orb";
import { useGraphStore } from "../../stores/graphStore";
import type { GraphNode } from "../../lib/api";

// ---- Label → Visual Mapping ------------------------------------------------

const LABEL_COLORS: Record<string, string> = {
  MemoryUnit: "#60a5fa",
  Entity: "#34d399",
  Chunk: "#8888a0",
  Community: "#fbbf24",
  Solution: "#7c5cfc",
  Conversation: "#f472b6",
  Message: "#a78bfa",
  Skill: "#fb923c",
  WorkflowExecution: "#22d3ee",
};

const DEFAULT_COLOR = "#6b6b80";

function getNodeColor(labels: string[]): string {
  for (const label of labels) {
    if (LABEL_COLORS[label]) return LABEL_COLORS[label];
  }
  return DEFAULT_COLOR;
}

function getNodeSize(node: GraphNode): number {
  const base = 6;
  if (node.labels?.includes("Community")) return base + 4;
  if (node.labels?.includes("Solution")) return base + 3;
  if (node.labels?.includes("Entity")) return base + 2;
  return base;
}

// ---- Custom node data for Orb -----------------------------------------------
interface OrbNodeData extends INodeBase {
  _gid: string;
  _labels: string[];
  _name: string;
}

interface OrbEdgeData extends IEdgeBase {
  _type: string;
}

// ---- Component ---------------------------------------------------------------

export function GraphCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<Orb<OrbNodeData, OrbEdgeData> | null>(null);

  const {
    nodes, edges, selectedNodeId, loading,
    setSelectedNode, expandNode, filters,
  } = useGraphStore();

  // Filter nodes based on active filters
  const filteredNodes = nodes.filter((n) => {
    if (filters.labels.length > 0) {
      if (!n.labels?.some((l: string) => filters.labels.includes(l))) return false;
    }
    if (filters.searchQuery) {
      const q = filters.searchQuery.toLowerCase();
      const name = (n.name as string || "").toLowerCase();
      const desc = (n.description as string || "").toLowerCase();
      const id = (n.id || "").toLowerCase();
      if (!name.includes(q) && !desc.includes(q) && !id.includes(q)) return false;
    }
    return true;
  });

  const filteredNodeIds = new Set(filteredNodes.map((n) => n.id));
  const filteredEdges = edges.filter(
    (e) => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target),
  );

  // Initialize Orb
  useEffect(() => {
    if (!containerRef.current) return;

    // Clean up previous instance by removing children
    if (orbRef.current) {
      orbRef.current = null;
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
    }

    if (filteredNodes.length === 0) return;

    const orb = new Orb<OrbNodeData, OrbEdgeData>(containerRef.current);

    // Map nodes/edges for Orb
    const nodeIdToIndex = new Map<string, number>();
    const orbNodes: OrbNodeData[] = filteredNodes.map((n, i) => {
      nodeIdToIndex.set(n.id, i);
      return {
        id: i,
        _gid: n.id,
        _labels: n.labels ?? [],
        _name: (n.name as string) || n.id,
      };
    });

    const orbEdges: OrbEdgeData[] = filteredEdges
      .map((e, i) => {
        const startIdx = nodeIdToIndex.get(e.source);
        const endIdx = nodeIdToIndex.get(e.target);
        if (startIdx === undefined || endIdx === undefined) return null;
        return {
          id: i,
          start: startIdx,
          end: endIdx,
          _type: e.type,
        };
      })
      .filter((e): e is OrbEdgeData => e !== null);

    // Style settings
    orb.data.setDefaultStyle({
      getNodeStyle(node) {
        const color = getNodeColor(node.data._labels);
        const graphNode = filteredNodes.find((n) => n.id === node.data._gid);
        const size = getNodeSize(graphNode ?? { id: node.data._gid, labels: node.data._labels });
        const isSelected = node.data._gid === selectedNodeId;

        return {
          size,
          color,
          borderWidth: isSelected ? 3 : 1,
          borderColor: isSelected ? "#ffffff" : color,
          fontSize: 3,
          label: node.data._name,
          fontColor: "#e8e8f0",
          fontBackgroundColor: "rgba(10, 10, 15, 0.7)",
        };
      },
      getEdgeStyle(edge) {
        return {
          color: "#2a2a3e",
          colorHover: "#7c5cfc",
          colorSelected: "#7c5cfc",
          width: 0.5,
          widthHover: 1.5,
          widthSelected: 1.5,
          fontSize: 2.5,
          label: edge.data._type,
          fontColor: "#a0a0b8",
        };
      },
    });

    orb.data.setup({ nodes: orbNodes, edges: orbEdges });

    // Event handlers — using OrbEventType enum
    orb.events.on(OrbEventType.NODE_CLICK, (event) => {
      if (event?.node) {
        const gid = event.node.data._gid;
        if (gid) setSelectedNode(gid);
      }
    });

    orb.events.on(OrbEventType.NODE_DOUBLE_CLICK, (event) => {
      if (event?.node) {
        const gid = event.node.data._gid;
        if (gid) expandNode(gid);
      }
    });

    orb.events.on(OrbEventType.MOUSE_CLICK, (event) => {
      // Only deselect if no subject (node/edge) was clicked
      if (!event.subject) {
        setSelectedNode(null);
      }
    });

    // Render
    orb.view.render(() => {
      orb.view.recenter();
    });

    orbRef.current = orb;

    return () => {
      orbRef.current = null;
      // Clean up DOM
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredNodes.length, filteredEdges.length, filters.labels.join(","), filters.searchQuery]);

  const handleRecenter = useCallback(() => {
    orbRef.current?.view.recenter();
  }, []);

  if (loading) {
    return (
      <div className="graph-canvas-container">
        <div className="graph-loading">
          <div className="tab-loading-spinner" />
          <p>Loading knowledge graph…</p>
        </div>
      </div>
    );
  }

  if (filteredNodes.length === 0 && !loading) {
    return (
      <div className="graph-canvas-container">
        <div className="graph-empty">
          <div className="graph-empty-content">
            <span className="graph-empty-icon">🕸️</span>
            <h3>No Graph Data</h3>
            <p>Select a solution or ingest some documents to populate the knowledge graph.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="graph-canvas-container">
      <div ref={containerRef} className="graph-canvas-orb" />
      <div className="graph-canvas-actions">
        <button className="dag-ctrl-btn icon" onClick={handleRecenter} title="Fit to view">
          ⊞
        </button>
      </div>
      <div className="graph-node-count">
        {filteredNodes.length} nodes · {filteredEdges.length} edges
      </div>
    </div>
  );
}

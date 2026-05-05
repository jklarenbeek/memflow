import './Graph.css';
/**
 * GraphExplorer — Layout wrapper for the Graph tab
 *
 * Composes GraphFilters, GraphCanvas, NodeDetails, and CommunityPanel
 * into the full Graph Explorer view. Triggers initial data load.
 */
import { useEffect } from "react";
import { GraphCanvas } from "./GraphCanvas";
import { GraphFilters } from "./GraphFilters";
import { NodeDetails } from "./NodeDetails";
import { CommunityPanel } from "./CommunityPanel";
import { useGraphStore } from "../../stores/graphStore";
import { useAppStore } from "../../stores/appStore";

export function GraphExplorer() {
  const { loadInitialGraph, loadStats, nodes, loading, error } = useGraphStore();
  const { currentSolutionId } = useAppStore();

  // Load graph data when tab activates or solution changes
  useEffect(() => {
    if (nodes.length === 0 && !loading) {
      loadInitialGraph(currentSolutionId ?? undefined);
      loadStats(currentSolutionId ?? undefined);
    }
  }, [currentSolutionId, loadInitialGraph, loadStats, nodes.length, loading]);

  return (
    <div className="graph-explorer">
      <GraphFilters />

      <div className="graph-main">
        <div className="graph-canvas-wrapper">
          <GraphCanvas />
          {error && (
            <div className="graph-error-banner">
              <span>⚠️ {error}</span>
            </div>
          )}
        </div>

        <CommunityPanel />
        <NodeDetails />
      </div>
    </div>
  );
}

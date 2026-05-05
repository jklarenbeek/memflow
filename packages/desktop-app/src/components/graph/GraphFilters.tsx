import './Graph.css';
/**
 * GraphFilters — Filter toolbar for graph exploration
 *
 * Provides label toggles, solution filter, time range, search,
 * stats summary, and action buttons (load full graph, recenter).
 */
import { useState, useCallback } from "react";
import { useGraphStore } from "../../stores/graphStore";
import { useAppStore } from "../../stores/appStore";

const AVAILABLE_LABELS = [
  { id: "Entity", icon: "💎", color: "#34d399" },
  { id: "MemoryUnit", icon: "🧠", color: "#60a5fa" },
  { id: "Chunk", icon: "📄", color: "#8888a0" },
  { id: "Community", icon: "🏘️", color: "#fbbf24" },
  { id: "Solution", icon: "⭐", color: "#7c5cfc" },
  { id: "Skill", icon: "🎯", color: "#fb923c" },
];

export function GraphFilters() {
  const { filters, setFilters, stats, nodes, edges, loadInitialGraph, loadFullGraph, toggleCommunityPanel, communityPanelOpen, loading } =
    useGraphStore();
  const { currentSolutionId } = useAppStore();
  const [searchInput, setSearchInput] = useState(filters.searchQuery);

  const toggleLabel = useCallback(
    (label: string) => {
      const current = filters.labels;
      const updated = current.includes(label)
        ? current.filter((l) => l !== label)
        : [...current, label];
      setFilters({ labels: updated });
    },
    [filters.labels, setFilters],
  );

  const handleSearch = useCallback(
    (value: string) => {
      setSearchInput(value);
      // Debounce search filter
      const timeout = setTimeout(() => {
        setFilters({ searchQuery: value });
      }, 300);
      return () => clearTimeout(timeout);
    },
    [setFilters],
  );

  const handleReload = useCallback(() => {
    loadInitialGraph(currentSolutionId ?? undefined);
  }, [loadInitialGraph, currentSolutionId]);

  const handleLoadFull = useCallback(() => {
    loadFullGraph(currentSolutionId ?? undefined);
  }, [loadFullGraph, currentSolutionId]);

  const totalGraphNodes = stats?.nodeCounts.reduce((s, c) => s + c.count, 0) ?? 0;

  return (
    <div className="graph-toolbar">
      {/* Left: Label toggles */}
      <div className="graph-toolbar-left">
        <div className="graph-label-toggles">
          {AVAILABLE_LABELS.map((label) => {
            const isActive = filters.labels.length === 0 || filters.labels.includes(label.id);
            return (
              <button
                key={label.id}
                className={`graph-label-toggle ${isActive ? "active" : "dimmed"}`}
                onClick={() => toggleLabel(label.id)}
                title={label.id}
                style={{
                  borderColor: isActive ? label.color : "transparent",
                  color: isActive ? label.color : undefined,
                }}
              >
                <span className="graph-toggle-icon">{label.icon}</span>
                <span className="graph-toggle-label">{label.id}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Center: Search */}
      <div className="graph-toolbar-center">
        <input
          type="text"
          className="graph-search-input"
          placeholder="Search nodes…"
          value={searchInput}
          onChange={(e) => handleSearch(e.target.value)}
        />
      </div>

      {/* Right: Actions + Stats */}
      <div className="graph-toolbar-right">
        <span className="graph-stats-mini">
          {nodes.length} / {totalGraphNodes} nodes · {edges.length} edges
        </span>

        <button
          className="dag-ctrl-btn"
          onClick={() => toggleCommunityPanel()}
          title="Toggle community panel"
        >
          🏘️ {communityPanelOpen ? "Hide" : "Communities"}
        </button>

        {totalGraphNodes > 0 && totalGraphNodes <= 500 && nodes.length < totalGraphNodes && (
          <button
            className="dag-ctrl-btn accent"
            onClick={handleLoadFull}
            disabled={loading}
            title="Load entire graph (small graph)"
          >
            📥 Load Full
          </button>
        )}

        <button
          className="dag-ctrl-btn"
          onClick={handleReload}
          disabled={loading}
          title="Reload graph"
        >
          🔄 Reload
        </button>
      </div>
    </div>
  );
}

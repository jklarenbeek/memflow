/**
 * SolutionList — Create/select/delete Solutions
 */
import { useState, useEffect, useCallback } from "react";
import { useAppStore } from "../../stores/appStore";
import { api } from "../../lib/api";

interface Solution {
  id: string;
  name: string;
  domain: string;
  stats?: { entityCount: number; memoryCount: number; conversationCount: number };
}

export function SolutionList() {
  const [solutions, setSolutions] = useState<Solution[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { currentSolutionId, setCurrentSolution, serverUrl } = useAppStore();

  const loadSolutions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      api.setBaseUrl(serverUrl);
      const res = await api.listSolutions();
      setSolutions(res.solutions as unknown as Solution[]);
    } catch (err) {
      setError("Failed to load solutions");
      console.error("Failed to load solutions:", err);
    } finally {
      setLoading(false);
    }
  }, [serverUrl]);

  useEffect(() => { loadSolutions(); }, [loadSolutions]);

  const createSolution = async () => {
    if (!newName.trim()) return;
    try {
      const res = await api.createSolution({ name: newName.trim() });
      const sol = res.solution as unknown as Solution;
      setSolutions([sol, ...solutions]);
      setCurrentSolution(sol.id);
      setNewName("");
      setCreating(false);
    } catch (err) {
      console.error("Failed to create solution:", err);
      setError("Failed to create solution");
    }
  };

  const deleteSolution = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this solution? This action cannot be undone.")) return;
    try {
      await api.deleteSolution(id);
      setSolutions(solutions.filter(s => s.id !== id));
      if (currentSolutionId === id) {
        setCurrentSolution(null);
      }
    } catch (err) {
      console.error("Failed to delete solution:", err);
      setError("Failed to delete solution");
    }
  };

  const domainIcons: Record<string, string> = {
    research: "📚",
    trading: "📈",
    custom: "⚙️",
    engineering: "🔧",
    creative: "🎨",
  };

  return (
    <div className="solution-list">
      <div className="section-header">
        <h3>Solutions</h3>
        <button className="btn-icon" onClick={() => setCreating(!creating)} title="New Solution">+</button>
      </div>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button className="btn-dismiss" onClick={() => setError(null)}>×</button>
        </div>
      )}

      {creating && (
        <div className="create-form">
          <input
            type="text" placeholder="Solution name..." value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createSolution()}
            autoFocus
          />
          <div className="create-actions">
            <button className="btn-sm" onClick={createSolution}>Create</button>
            <button className="btn-sm btn-ghost" onClick={() => { setCreating(false); setNewName(""); }}>Cancel</button>
          </div>
        </div>
      )}

      <div className="solution-items">
        {loading && (
          <div className="loading-items">
            <div className="skeleton-line" />
            <div className="skeleton-line short" />
            <div className="skeleton-line" />
          </div>
        )}
        {solutions.map((sol) => (
          <button
            key={sol.id}
            className={`solution-item ${sol.id === currentSolutionId ? "active" : ""}`}
            onClick={() => setCurrentSolution(sol.id)}
          >
            <span className="solution-icon">{domainIcons[sol.domain] ?? "📁"}</span>
            <div className="solution-info">
              <span className="solution-name">{sol.name}</span>
              <span className="solution-domain">{sol.domain}</span>
              {sol.stats && (
                <span className="solution-stats">
                  {sol.stats.entityCount} entities · {sol.stats.memoryCount} memories
                </span>
              )}
            </div>
            <button className="solution-delete" onClick={(e) => deleteSolution(sol.id, e)} title="Delete">×</button>
          </button>
        ))}
        {solutions.length === 0 && !creating && !loading && (
          <p className="empty-state">No solutions yet. Create one to get started.</p>
        )}
      </div>
    </div>
  );
}

import './Sidebar.css';
/**
 * SolutionList — Create/select/delete Solutions with wizard support
 */
import { useState, useEffect, useCallback } from "react";
import { useAppStore } from "../../stores/appStore";
import { api } from "../../lib/api";
import { SolutionWizard } from "../solutions/SolutionWizard";

interface Solution {
  id: string;
  name: string;
  domain: string;
  stats?: { entityCount: number; memoryCount: number; conversationCount: number };
}

export function SolutionList() {
  const [solutions, setSolutions] = useState<Solution[]>([]);
  const [loading, setLoading] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
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

  const handleWizardCreated = useCallback((solution: Record<string, unknown>) => {
    setSolutions((prev) => [solution as unknown as Solution, ...prev]);
  }, []);

  const domainIcons: Record<string, string> = {
    research: "📚",
    trading: "📈",
    custom: "⚙️",
    engineering: "🔧",
    creative: "🎨",
    healthcare: "🏥",
    legal: "⚖️",
  };

  return (
    <div className="solution-list">
      <div className="section-header">
        <h3>Solutions</h3>
        <button className="btn-icon" onClick={() => setWizardOpen(true)} title="New Solution">+</button>
      </div>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button className="btn-dismiss" onClick={() => setError(null)}>×</button>
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
        {solutions.length === 0 && !wizardOpen && !loading && (
          <p className="empty-state">No solutions yet. Create one to get started.</p>
        )}
      </div>

      <SolutionWizard
        isOpen={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={handleWizardCreated}
      />
    </div>
  );
}

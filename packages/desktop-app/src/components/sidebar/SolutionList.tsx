/**
 * SolutionList — Create/select/delete Solutions
 */
import { useState, useEffect } from "react";
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
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const { currentSolutionId, setCurrentSolution, serverUrl } = useAppStore();

  const loadSolutions = async () => {
    try {
      api.setBaseUrl(serverUrl);
      const res = await api.listSolutions();
      setSolutions(res.solutions as unknown as Solution[]);
    } catch { /* server may not be ready */ }
  };

  useEffect(() => { loadSolutions(); }, [serverUrl]);

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
    }
  };

  return (
    <div className="solution-list">
      <div className="section-header">
        <h3>Solutions</h3>
        <button className="btn-icon" onClick={() => setCreating(!creating)} title="New Solution">+</button>
      </div>

      {creating && (
        <div className="create-form">
          <input
            type="text" placeholder="Solution name..." value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createSolution()}
            autoFocus
          />
          <button className="btn-sm" onClick={createSolution}>Create</button>
        </div>
      )}

      <div className="solution-items">
        {solutions.map((sol) => (
          <button
            key={sol.id}
            className={`solution-item ${sol.id === currentSolutionId ? "active" : ""}`}
            onClick={() => setCurrentSolution(sol.id)}
          >
            <span className="solution-name">{sol.name}</span>
            <span className="solution-domain">{sol.domain}</span>
            {sol.stats && (
              <span className="solution-stats">
                {sol.stats.entityCount} entities · {sol.stats.memoryCount} memories
              </span>
            )}
          </button>
        ))}
        {solutions.length === 0 && !creating && (
          <p className="empty-state">No solutions yet. Create one to get started.</p>
        )}
      </div>
    </div>
  );
}

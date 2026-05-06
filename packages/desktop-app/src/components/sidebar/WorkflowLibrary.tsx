import './Sidebar.css';
/**
 * WorkflowLibrary — Browse, search, and run pre-built workflows
 *
 * Click a workflow card to load it in the DAG Runner tab.
 */
import { useState, useEffect, useCallback } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/appStore";
import { useDAGStore, type DAGWorkflow } from "../../stores/dagStore";

interface WorkflowEntry {
  name: string;
  version: string;
  description: string;
  category: string;
  stageCount: number;
}

export function WorkflowLibrary() {
  const [workflows, setWorkflows] = useState<WorkflowEntry[]>([]);
  const [search, setSearch] = useState("");
  const { serverUrl, setActiveTab } = useAppStore();
  const loadWorkflow = useDAGStore((s) => s.loadWorkflow);

  useEffect(() => {
    const load = async () => {
      try {
        api.setBaseUrl(serverUrl);
        const res = await api.listWorkflows();
        setWorkflows(res.workflows as unknown as WorkflowEntry[]);
      } catch { /* server may not be ready */ }
    };
    load();
  }, [serverUrl]);

  const filtered = workflows.filter((w) =>
    w.name.toLowerCase().includes(search.toLowerCase()) ||
    w.description.toLowerCase().includes(search.toLowerCase())
  );

  const categories = [...new Set(filtered.map((w) => w.category))];

  /** Load a workflow into the DAG Runner and switch tabs */
  const handleLoadWorkflow = useCallback(
    async (name: string) => {
      try {
        const result = await api.getWorkflow(name);
        loadWorkflow(result.workflow as unknown as DAGWorkflow);
        setActiveTab("dag");
      } catch (err) {
        console.error("Failed to load workflow:", err);
      }
    },
    [loadWorkflow, setActiveTab],
  );

  return (
    <div className="workflow-library">
      <div className="section-header">
        <h3>Workflows</h3>
      </div>

      <input
        type="text" placeholder="Search workflows..."
        className="search-input" value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {categories.map((cat) => (
        <div key={cat} className="workflow-category">
          <h4 className="category-label">{cat}</h4>
          {filtered.filter((w) => w.category === cat).map((wf) => (
            <div
              key={wf.name}
              className="workflow-card"
              onClick={() => handleLoadWorkflow(wf.name)}
              title={wf.description || undefined}
            >
              <div className="wf-header">
                <span className="wf-name">{wf.name}</span>
                <span className="wf-version">v{wf.version}</span>
              </div>
              <p className="wf-desc">{wf.description || "No description"}</p>
              <span className="wf-stages">{wf.stageCount} stages</span>
            </div>
          ))}
        </div>
      ))}

      {workflows.length === 0 && (
        <p className="empty-state">Connect to MemFlow to see workflows.</p>
      )}
    </div>
  );
}


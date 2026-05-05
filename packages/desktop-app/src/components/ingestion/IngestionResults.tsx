import './Ingestion.css';
/**
 * IngestionResults — Summary of completed ingestion
 *
 * Shows aggregate counts (chunks, entities, memories) across all
 * successfully ingested files, with navigation to Graph tab.
 */
import { useIngestionStore } from "../../stores/ingestionStore";
import { useAppStore } from "../../stores/appStore";

export function IngestionResults() {
  const { files, getTotals } = useIngestionStore();
  const { setActiveTab } = useAppStore();

  const completedFiles = files.filter((f) => f.status === "complete");
  if (completedFiles.length === 0) return null;

  const totals = getTotals();

  return (
    <div className="ingestion-results-section">
      <h4 className="file-queue-header">
        <span>Results ({completedFiles.length} files ingested)</span>
      </h4>

      <div className="ingestion-results">
        <div className="result-card">
          <span className="result-value">{totals.chunks}</span>
          <span className="result-label">Chunks</span>
        </div>
        <div className="result-card">
          <span className="result-value">{totals.entities}</span>
          <span className="result-label">Entities</span>
        </div>
        <div className="result-card">
          <span className="result-value">{totals.memories}</span>
          <span className="result-label">Memories</span>
        </div>
      </div>

      <div className="ingestion-actions">
        <button className="btn-primary" onClick={() => setActiveTab("graph")}>
          🕸️ View in Graph
        </button>
      </div>
    </div>
  );
}

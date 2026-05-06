import './Ingestion.css';
/**
 * FileQueue — Per-file progress tracking list
 *
 * Shows each file in the ingestion queue with status, progress bar,
 * current pipeline stage, chunk-level sub-progress, and remove/clear actions.
 * Each file with a workflow can navigate to the DAG Runner for live visualization.
 */
import { useIngestionStore, type IngestionFile } from "../../stores/ingestionStore";
import { useAppStore } from "../../stores/appStore";
import { useDAGStore } from "../../stores/dagStore";
import { formatFileSize } from "./DropZone";

const STATUS_ICONS: Record<string, string> = {
  queued: "⏳",
  uploading: "⬆️",
  processing: "⚙️",
  complete: "✅",
  error: "❌",
};

const FILE_ICONS: Record<string, string> = {
  pdf: "📕",
  docx: "📘",
  md: "📝",
  txt: "📄",
};

function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return FILE_ICONS[ext] ?? "📄";
}

function formatElapsed(startedAt?: string): string {
  if (!startedAt) return "";
  const elapsed = Date.now() - new Date(startedAt).getTime();
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function ChunkProgressBar({ file }: { file: IngestionFile }) {
  if (!file.chunkProgress || file.chunkProgress.total === 0) return null;
  const { current, total, failed } = file.chunkProgress;
  const pct = Math.round((current / total) * 100);

  return (
    <div className="chunk-progress">
      <div className="chunk-progress-bar">
        <div
          className="chunk-progress-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="chunk-progress-label">
        {current}/{total}
        {failed > 0 && <span className="chunk-failed"> ({failed} fallback)</span>}
      </span>
    </div>
  );
}

export function FileQueue() {
  const { files, removeFile, clearCompleted } = useIngestionStore();
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setActiveProcess = useDAGStore((s) => s.setActiveProcess);

  if (files.length === 0) return null;

  const hasCompleted = files.some((f) => f.status === "complete" || f.status === "error");

  /** Navigate to DAG Runner showing this file's workflow */
  const handleViewInDAG = (file: IngestionFile) => {
    setActiveProcess(file.id);
    setActiveTab("dag");
  };

  /** Whether the "View in DAG" button should be shown */
  const canViewInDAG = (file: IngestionFile) =>
    !!file.workflow && file.status !== "queued" && file.status !== "uploading";

  return (
    <div className="file-queue">
      <div className="file-queue-header">
        <h4>File Queue ({files.length})</h4>
        {hasCompleted && (
          <button className="btn-ghost" onClick={clearCompleted}>
            Clear completed
          </button>
        )}
      </div>

      {files.map((file) => (
        <div key={file.id} className="file-row">
          <span className="file-icon">{getFileIcon(file.name)}</span>

          <div className="file-info">
            <div className="file-name">{file.name}</div>
            <div className="file-meta">
              {formatFileSize(file.size)}
              {file.status === "processing" && file.startedAt && (
                <span className="file-elapsed"> · {formatElapsed(file.startedAt)}</span>
              )}
              {file.currentStage && (
                <span className="file-stage"> · {file.currentStage}</span>
              )}
              {file.error && (
                <span className="file-stage" style={{ color: "var(--error)" }}>
                  {" "}· {file.error}
                </span>
              )}
            </div>

            {(file.status === "uploading" || file.status === "processing") && (
              <div className="file-progress">
                <div
                  className={`file-progress-bar ${file.status}`}
                  style={{ width: `${file.progress}%` }}
                />
              </div>
            )}

            {/* Chunk-level sub-progress (e.g., FactExtractor chunk 15/52) */}
            {file.status === "processing" && <ChunkProgressBar file={file} />}

            {file.status === "complete" && file.result && (
              <div className="file-meta">
                {file.result.chunks} chunks · {file.result.entities} entities · {file.result.memories} memories
              </div>
            )}
          </div>

          <span className={`file-status-badge ${file.status}`}>
            {STATUS_ICONS[file.status]} {file.status}
          </span>

          {/* View in DAG Runner button */}
          {canViewInDAG(file) && (
            <button
              className="file-dag-btn"
              onClick={() => handleViewInDAG(file)}
              title="View workflow in DAG Runner"
            >
              🔀 DAG
            </button>
          )}

          <button
            className="file-remove-btn"
            onClick={() => removeFile(file.id)}
            title="Remove"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}


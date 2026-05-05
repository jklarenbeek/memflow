import './Ingestion.css';
/**
 * FileQueue — Per-file progress tracking list
 *
 * Shows each file in the ingestion queue with status, progress bar,
 * current pipeline stage, and remove/clear actions.
 */
import { useIngestionStore } from "../../stores/ingestionStore";
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

export function FileQueue() {
  const { files, removeFile, clearCompleted } = useIngestionStore();

  if (files.length === 0) return null;

  const hasCompleted = files.some((f) => f.status === "complete" || f.status === "error");

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
              {file.currentStage && (
                <span className="file-stage"> · {file.currentStage}</span>
              )}
              {file.error && (
                <span className="file-stage" style={{ color: "var(--error)" }}>
                  {" "}
                  · {file.error}
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

            {file.status === "complete" && file.result && (
              <div className="file-meta">
                {file.result.chunks} chunks · {file.result.entities} entities · {file.result.memories} memories
              </div>
            )}
          </div>

          <span className={`file-status-badge ${file.status}`}>
            {STATUS_ICONS[file.status]} {file.status}
          </span>

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

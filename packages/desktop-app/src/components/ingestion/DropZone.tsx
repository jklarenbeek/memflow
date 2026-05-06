import './Ingestion.css';
/**
 * DropZone — Drag-and-drop file ingestion area
 *
 * Accepts .pdf, .docx, .md, .txt files via drag-and-drop or click-to-browse.
 * Supports dual-mode transport:
 *   - Tauri desktop: IPC file path mode
 *   - External server: multipart/form-data upload
 *
 * Features:
 *   - Quick Ingest toggle (skips LLM memory extraction for fast ~5s ingest)
 *   - Per-chunk progress tracking for long-running LLM stages
 *   - SSE keepalive and reconnection handling
 */
import { useCallback, useRef, useState, type DragEvent } from "react";
import { v4 as uuidv4 } from "uuid";
import { useIngestionStore } from "../../stores/ingestionStore";
import { useAppStore } from "../../stores/appStore";
import { api } from "../../lib/api";

const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".md", ".txt", ".markdown"];
const FORMAT_ICONS: Record<string, string> = {
  pdf: "📕",
  docx: "📘",
  md: "📝",
  txt: "📄",
  markdown: "📝",
};

function getFileExtension(name: string): string {
  return (name.split(".").pop() ?? "").toLowerCase();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface DropZoneProps {
  onFilesAdded?: () => void;
}

export function DropZone({ onFilesAdded }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { isDropActive, setDropActive, addFile, updateFile } = useIngestionStore();
  const { currentSolutionId, connectionMode } = useAppStore();
  const [error, setError] = useState<string | null>(null);
  const [skipMemory, setSkipMemory] = useState(false);

  const processFile = useCallback(
    async (file: File) => {
      const ext = getFileExtension(file.name);
      if (!ACCEPTED_EXTENSIONS.includes(`.${ext}`)) {
        setError(`Unsupported file type: .${ext}`);
        return;
      }

      if (!currentSolutionId) {
        setError("Please select a Solution first");
        return;
      }

      const fileId = uuidv4();
      addFile({
        id: fileId,
        name: file.name,
        size: file.size,
        type: file.type || `application/${ext}`,
        status: "uploading",
        progress: 10,
        startedAt: new Date().toISOString(),
      });

      try {
        // Upload to ingestion endpoint (with skipMemory flag)
        updateFile(fileId, { status: "uploading", progress: 30 });
        const res = await api.ingestFile(file, currentSolutionId, skipMemory);

        const totalStages = skipMemory ? 4 : 5; // parse→chunk→embed→index [→store]
        updateFile(fileId, { status: "processing", progress: 50, currentStage: "Pipeline starting…" });

        // Now stream the workflow execution for real-time progress
        const streamRes = await fetch(api.getStreamUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workflow: res.workflow,
            input: { solutionId: currentSolutionId },
            tempFilePath: res.tempFilePath,
          }),
        });

        if (!streamRes.ok || !streamRes.body) {
          throw new Error(`Stream failed: ${streamRes.status}`);
        }

        const reader = streamRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let stageCount = 0;

        // Accumulate per-stage metrics for final result counts
        const stageMetrics: Record<string, Record<string, unknown>> = {};

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;

            try {
              const event = JSON.parse(jsonStr);
              switch (event.type) {
                case "stage:start":
                  updateFile(fileId, {
                    currentStage: `${event.module || event.stageId}`,
                    progress: 50 + Math.round((stageCount / totalStages) * 40),
                    chunkProgress: undefined, // Reset chunk progress for new stage
                  });
                  break;

                case "stage:progress":
                  // Per-chunk progress within a stage (e.g., FactExtractor chunk 15/52)
                  updateFile(fileId, {
                    currentStage: event.message || `${event.module} (${event.chunkIndex}/${event.totalChunks})`,
                    chunkProgress: event.chunkIndex && event.totalChunks ? {
                      current: event.chunkIndex,
                      total: event.totalChunks,
                      failed: event.detail?.failed ? 1 : 0,
                    } : undefined,
                    // Sub-progress within the current stage
                    progress: 50 + Math.round(
                      ((stageCount + (event.chunkIndex ?? 0) / (event.totalChunks ?? 1)) / totalStages) * 40,
                    ),
                  });
                  break;

                case "stage:complete":
                  stageCount++;
                  // Track per-stage metrics for result aggregation
                  if (event.metrics && event.stageId) {
                    stageMetrics[event.stageId] = event.metrics;
                  }
                  updateFile(fileId, {
                    progress: 50 + Math.round((stageCount / totalStages) * 40),
                    chunkProgress: undefined,
                    currentStage: event.module ? `${event.module} ✓` : undefined,
                  });
                  break;

                case "workflow:complete": {
                  // Build result from workflow metrics or accumulated stage metrics
                  const wm = event.metrics ?? {};
                  const chunkMetrics = stageMetrics["index"] ?? stageMetrics["chunk"] ?? {};
                  const storeMetrics = stageMetrics["store"] ?? {};

                  const chunks = (wm.chunks as number)
                    ?? (chunkMetrics.ingested as number)
                    ?? 0;
                  const entities = (wm.entities as number)
                    ?? (storeMetrics.extracted as number)
                    ?? 0;
                  const memories = (wm.memoryUnits as number)
                    ?? (storeMetrics.after as number)
                    ?? (storeMetrics.merged as number)
                    ?? 0;

                  updateFile(fileId, {
                    status: "complete",
                    progress: 100,
                    currentStage: undefined,
                    chunkProgress: undefined,
                    completedAt: new Date().toISOString(),
                    result: { chunks, entities, memories },
                  });
                  break;
                }

                case "workflow:error":
                  updateFile(fileId, {
                    status: "error",
                    progress: 0,
                    error: event.error,
                    currentStage: undefined,
                    chunkProgress: undefined,
                  });
                  break;

                case "keepalive":
                  // Keepalive pings — ignore silently
                  break;
              }
            } catch { /* skip unparseable */ }
          }
        }

        // If stream ended without explicit workflow:complete, mark as complete
        const current = useIngestionStore.getState().files.find((f) => f.id === fileId);
        if (current?.status === "processing") {
          updateFile(fileId, {
            status: "complete",
            progress: 100,
            currentStage: undefined,
            chunkProgress: undefined,
            completedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        updateFile(fileId, {
          status: "error",
          progress: 0,
          error: (err as Error).message,
          currentStage: undefined,
          chunkProgress: undefined,
        });
      }
    },
    [currentSolutionId, connectionMode, skipMemory, addFile, updateFile],
  );

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setDropActive(false);
      setError(null);

      const files = Array.from(e.dataTransfer.files);
      files.forEach(processFile);
      onFilesAdded?.();
    },
    [processFile, setDropActive, onFilesAdded],
  );

  const handleDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setDropActive(true);
    },
    [setDropActive],
  );

  const handleDragLeave = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setDropActive(false);
    },
    [setDropActive],
  );

  const handleClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setError(null);
      const files = Array.from(e.target.files ?? []);
      files.forEach(processFile);
      onFilesAdded?.();
      // Reset input so same file can be selected again
      e.target.value = "";
    },
    [processFile, onFilesAdded],
  );

  return (
    <div
      className={`drop-zone ${isDropActive ? "drag-active" : ""}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onClick={handleClick}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,.md,.txt,.markdown"
        multiple
        style={{ display: "none" }}
        onChange={handleFileInput}
      />

      <span className="drop-zone-icon">📥</span>
      <h3>Drop files to ingest</h3>
      <p>or click to browse</p>

      <div className="drop-zone-formats">
        {Object.entries(FORMAT_ICONS).map(([ext, icon]) => (
          <span key={ext} className="format-badge">
            {icon} .{ext}
          </span>
        ))}
      </div>

      <label
        className="quick-ingest-toggle"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={skipMemory}
          onChange={(e) => setSkipMemory(e.target.checked)}
        />
        <span className="toggle-label">
          ⚡ Quick ingest
          <span className="toggle-hint">(skip LLM extraction — fast ~5s)</span>
        </span>
      </label>

      {error && <p className="drop-zone-error">⚠️ {error}</p>}

      {!currentSolutionId && (
        <p className="drop-zone-error">Select a solution in the sidebar first</p>
      )}
    </div>
  );
}

export { formatFileSize };

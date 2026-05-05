/**
 * PatternConfigForm — GMPL pattern configuration and execution dialog
 *
 * Provides a prompt input and runs the pattern via SSE streaming.
 * Shows live execution output as the workflow progresses.
 */
import { useState, useCallback, useRef } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/appStore";

interface Pattern {
  id: string;
  version?: string;
  description: string;
  workflowRef?: string;
  requiredRoles: string[];
}

interface PatternConfigFormProps {
  pattern: Pattern;
  onClose: () => void;
}

export function PatternConfigForm({ pattern, onClose }: PatternConfigFormProps) {
  const { currentSolutionId } = useAppStore();
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const handleRun = useCallback(async () => {
    if (!prompt.trim()) return;
    if (!currentSolutionId) {
      setError("Select a solution first");
      return;
    }

    setRunning(true);
    setOutput([]);
    setError(null);

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      // Build a simple workflow from the pattern
      const workflowConfig = {
        name: `gmpl-${pattern.id}`,
        version: "1.0",
        pattern: pattern.id,
        entry: "run",
        stages: [
          {
            id: "run",
            module: "PatternComposer",
            config: {
              patternId: pattern.id,
              prompt: prompt.trim(),
              solutionId: currentSolutionId,
            },
            next: null,
          },
        ],
      };

      const res = await fetch(api.getStreamUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow: workflowConfig,
          input: { query: prompt.trim(), solutionId: currentSolutionId },
        }),
        signal: abortController.signal,
      });

      if (!res.ok || !res.body) throw new Error(`Stream failed: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

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
                setOutput((prev) => [...prev, `▶ Starting ${event.module ?? event.stageId}…`]);
                break;
              case "stage:progress":
                if (event.token) {
                  setOutput((prev) => {
                    const last = prev[prev.length - 1];
                    if (last && !last.startsWith("▶") && !last.startsWith("✅") && !last.startsWith("❌")) {
                      return [...prev.slice(0, -1), last + event.token];
                    }
                    return [...prev, event.token];
                  });
                }
                break;
              case "stage:complete":
                setOutput((prev) => [
                  ...prev,
                  `✅ ${event.module ?? event.stageId} completed (${event.durationMs}ms)`,
                ]);
                break;
              case "workflow:complete":
                if (event.finalAnswer) {
                  setOutput((prev) => [...prev, "\n--- Final Answer ---\n", event.finalAnswer]);
                }
                break;
              case "workflow:error":
                setError(event.error);
                break;
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError((err as Error).message);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [prompt, pattern, currentSolutionId]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
  }, []);

  return (
    <div className="pattern-config-overlay" onClick={onClose}>
      <div className="pattern-config-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="settings-header">
          <h2>🧩 {pattern.id}</h2>
          <button className="settings-close" onClick={onClose}>×</button>
        </div>

        {/* Body */}
        <div className="pattern-config-body">
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 8 }}>
            {pattern.description}
          </p>

          {pattern.requiredRoles.length > 0 && (
            <div className="pattern-card-roles" style={{ marginBottom: 12 }}>
              {pattern.requiredRoles.map((role) => (
                <span key={role} className="pattern-role-tag">{role}</span>
              ))}
            </div>
          )}

          <div className="pattern-config-field">
            <label>Prompt</label>
            <textarea
              rows={3}
              placeholder="Enter your prompt for this pattern…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={running}
            />
          </div>

          {/* Output */}
          {output.length > 0 && (
            <div className="inspector-json" style={{ maxHeight: 300, overflowY: "auto" }}>
              {output.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}

          {error && (
            <div className="wizard-feedback error">⚠️ {error}</div>
          )}
        </div>

        {/* Footer */}
        <div className="pattern-config-actions">
          {running ? (
            <button className="btn-cancel" onClick={handleCancel}>Cancel</button>
          ) : (
            <button
              className="btn-primary btn-lg"
              onClick={handleRun}
              disabled={!prompt.trim() || !currentSolutionId}
            >
              ▶ Run Pattern
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

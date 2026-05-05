import './GMPL.css';
/**
 * PatternSelector — GMPL pattern card grid with quick-run
 *
 * Fetches patterns from /api/v1/gmpl/patterns and renders them
 * as clickable cards. Clicking opens PatternConfigForm for execution.
 */
import { useState, useEffect, useCallback } from "react";
import { api } from "../../lib/api";
import { PatternConfigForm } from "./PatternConfigForm";

interface Pattern {
  id: string;
  version?: string;
  description: string;
  workflowRef?: string;
  requiredRoles: string[];
  observabilityEvents?: string[];
  hasConfigSchema: boolean;
}

const PATTERN_ICONS: Record<string, string> = {
  debate: "🎭",
  peer_review: "📝",
  red_team: "🛡️",
  round_robin: "🔄",
  map_reduce: "🗺️",
  orchestrator: "🎼",
  pipeline: "⛓️",
};

export function PatternSelector() {
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedPattern, setSelectedPattern] = useState<Pattern | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPatterns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listPatterns();
      setPatterns(res.patterns);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPatterns(); }, [loadPatterns]);

  if (loading) {
    return (
      <div className="pattern-grid">
        {[1, 2, 3].map((i) => (
          <div key={i} className="pattern-card">
            <div className="skeleton-line" style={{ width: "60%", height: 14 }} />
            <div className="skeleton-line" style={{ width: "100%", height: 12, marginTop: 8 }} />
            <div className="skeleton-line" style={{ width: "40%", height: 10, marginTop: 8 }} />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="pattern-grid">
        <div className="empty-state">
          ⚠️ Failed to load patterns: {error}
          <button className="btn-ghost" style={{ marginTop: 8 }} onClick={loadPatterns}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="pattern-grid">
        {patterns.length === 0 && (
          <div className="empty-state">No GMPL patterns registered.</div>
        )}
        {patterns.map((pattern) => (
          <div
            key={pattern.id}
            className="pattern-card"
            onClick={() => setSelectedPattern(pattern)}
          >
            <div className="pattern-card-header">
              <span className="pattern-card-name">
                {PATTERN_ICONS[pattern.id] ?? "🧩"} {pattern.id}
              </span>
              {pattern.version && (
                <span className="pattern-card-version">v{pattern.version}</span>
              )}
            </div>
            <p className="pattern-card-desc">
              {pattern.description || "No description available"}
            </p>
            <div className="pattern-card-roles">
              {pattern.requiredRoles.map((role) => (
                <span key={role} className="pattern-role-tag">{role}</span>
              ))}
              {pattern.requiredRoles.length === 0 && (
                <span className="pattern-role-tag">No roles required</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {selectedPattern && (
        <PatternConfigForm
          pattern={selectedPattern}
          onClose={() => setSelectedPattern(null)}
        />
      )}
    </>
  );
}

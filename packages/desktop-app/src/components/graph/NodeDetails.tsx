import './Graph.css';
/**
 * NodeDetails — Side panel for selected graph node properties
 *
 * Shows node metadata, labels, properties, and actions.
 * Re-uses the inspector slide-out pattern from the DAG view.
 */
import { useGraphStore } from "../../stores/graphStore";
import { useAppStore } from "../../stores/appStore";

const LABEL_COLORS: Record<string, string> = {
  MemoryUnit: "#60a5fa",
  Entity: "#34d399",
  Chunk: "#8888a0",
  Community: "#fbbf24",
  Solution: "#7c5cfc",
  Conversation: "#f472b6",
  Message: "#a78bfa",
  Skill: "#fb923c",
  WorkflowExecution: "#22d3ee",
};

const LABEL_ICONS: Record<string, string> = {
  MemoryUnit: "🧠",
  Entity: "💎",
  Chunk: "📄",
  Community: "🏘️",
  Solution: "⭐",
  Conversation: "💬",
  Message: "✉️",
  Skill: "🎯",
  WorkflowExecution: "▶️",
};

/** Keys to exclude from the property grid */
const HIDDEN_KEYS = new Set(["id", "labels", "elementId", "identity"]);

export function NodeDetails() {
  const { selectedNodeData, detailsPanelOpen, setSelectedNode, expandNode, expandedNodeIds, edges } =
    useGraphStore();
  const { setActiveTab } = useAppStore();

  if (!detailsPanelOpen || !selectedNodeData) return null;

  const node = selectedNodeData;
  const labels = node.labels ?? [];
  const isExpanded = expandedNodeIds.has(node.id);

  // Count edges for this node
  const incomingCount = edges.filter((e) => e.target === node.id).length;
  const outgoingCount = edges.filter((e) => e.source === node.id).length;

  // Collect display properties (exclude internal keys)
  const properties = Object.entries(node).filter(
    ([key]) => !HIDDEN_KEYS.has(key) && key !== "labels",
  );

  return (
    <div className="graph-node-details">
      {/* Header */}
      <div className="graph-details-header">
        <div className="graph-details-title">
          <span className="graph-details-icon">
            {labels.map((l) => LABEL_ICONS[l] ?? "📦").join("")}
          </span>
          <div>
            <h4>{(node.name as string) || node.id}</h4>
            <div className="graph-details-labels">
              {labels.map((label) => (
                <span
                  key={label}
                  className="graph-label-badge"
                  style={{ background: `${LABEL_COLORS[label] ?? "#6b6b80"}22`, color: LABEL_COLORS[label] ?? "#6b6b80" }}
                >
                  {label}
                </span>
              ))}
            </div>
          </div>
        </div>
        <button className="inspector-close" onClick={() => setSelectedNode(null)}>
          ×
        </button>
      </div>

      {/* Body */}
      <div className="graph-details-body">
        {/* ID */}
        <div className="graph-details-section">
          <h5>Identifier</h5>
          <div className="graph-details-id">{node.id}</div>
        </div>

        {/* Properties */}
        {properties.length > 0 && (
          <div className="graph-details-section">
            <h5>Properties</h5>
            <div className="inspector-grid">
              {properties.map(([key, value]) => (
                <div className="graph-prop-row" key={key}>
                  <span className="inspector-label">{key}</span>
                  <span className="inspector-value">
                    {typeof value === "object" ? JSON.stringify(value, null, 2).slice(0, 200) : String(value ?? "—")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Connections */}
        <div className="graph-details-section">
          <h5>Connections</h5>
          <div className="graph-details-connections">
            <div className="graph-conn-stat">
              <span className="graph-conn-label">Incoming</span>
              <span className="graph-conn-value">{incomingCount}</span>
            </div>
            <div className="graph-conn-stat">
              <span className="graph-conn-label">Outgoing</span>
              <span className="graph-conn-value">{outgoingCount}</span>
            </div>
            <div className="graph-conn-stat">
              <span className="graph-conn-label">Total</span>
              <span className="graph-conn-value">{incomingCount + outgoingCount}</span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="graph-details-section">
          <h5>Actions</h5>
          <div className="graph-details-actions">
            {!isExpanded && (
              <button className="btn-primary" onClick={() => expandNode(node.id)}>
                🔗 Expand Neighbors
              </button>
            )}
            {isExpanded && (
              <span className="graph-expanded-badge">✓ Neighbors expanded</span>
            )}
            {labels.includes("Conversation") && (
              <button className="btn-ghost" onClick={() => setActiveTab("chat")}>
                💬 Open in Chat
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * TabBar — Tab navigation for the main content area
 *
 * Provides horizontal tab switching between Chat, DAG, Graph, and Ingestion views.
 * Features keyboard navigation (Ctrl+1..4), animated active indicator,
 * and contextual badge indicators (e.g., running workflow count).
 */
import { useAppStore, type AppTab } from "../../stores/appStore";
import { useDAGStore } from "../../stores/dagStore";

const TAB_CONFIG: Array<{
  id: AppTab;
  label: string;
  icon: string;
  shortcut: string;
}> = [
  { id: "chat", label: "Chat", icon: "💬", shortcut: "1" },
  { id: "dag", label: "DAG Runner", icon: "🔀", shortcut: "2" },
  { id: "graph", label: "Graph", icon: "🕸️", shortcut: "3" },
  { id: "ingestion", label: "Ingest", icon: "📥", shortcut: "4" },
];

export function TabBar() {
  const { activeTab, setActiveTab } = useAppStore();
  const executionState = useDAGStore((s) => s.executionState);

  return (
    <div className="tab-bar" role="tablist">
      {TAB_CONFIG.map((tab) => {
        const isActive = activeTab === tab.id;
        const showBadge = tab.id === "dag" && executionState === "running";

        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            className={`tab-item ${isActive ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
            title={`${tab.label} (Ctrl+${tab.shortcut})`}
          >
            <span className="tab-icon">{tab.icon}</span>
            <span className="tab-label">{tab.label}</span>
            {showBadge && <span className="tab-badge pulse" />}
            {isActive && <span className="tab-indicator" />}
          </button>
        );
      })}
    </div>
  );
}

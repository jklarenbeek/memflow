/**
 * MemFlow Desktop — Root Application
 *
 * Tab-based layout with Chat, DAG Runner, Graph, and Ingestion views.
 */
import { useState, useCallback, useEffect, lazy, Suspense } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { TopBar } from "./components/layout/TopBar";
import { TabBar } from "./components/layout/TabBar";
import { StatusBar } from "./components/layout/StatusBar";
import { SolutionList } from "./components/sidebar/SolutionList";
import { ConversationTree } from "./components/sidebar/ConversationTree";
import { WorkflowLibrary } from "./components/sidebar/WorkflowLibrary";
import { ChatPane } from "./components/chat/ChatPane";
import { StageInspector, type StageDetail } from "./components/chat/StageInspector";
import { CommandPalette } from "./components/palette/CommandPalette";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { ConnectionWizard } from "./components/onboarding/ConnectionWizard";
import { useHealthPoller } from "./hooks/useMemFlowAPI";
import { useAppStore } from "./stores/appStore";
import "./App.css";

// Lazy-load heavy tab views
const WorkflowDAG = lazy(() =>
  import("./components/dag/WorkflowDAG").then((m) => ({ default: m.WorkflowDAG })),
);
const GraphExplorer = lazy(() =>
  import("./components/graph/GraphExplorer").then((m) => ({ default: m.GraphExplorer })),
);
const IngestionPanel = lazy(() =>
  import("./components/ingestion/IngestionPanel").then((m) => ({ default: m.IngestionPanel })),
);

function TabFallback({ label }: { label: string }) {
  return (
    <div className="tab-loading">
      <div className="tab-loading-spinner" />
      <p>Loading {label}…</p>
    </div>
  );
}


export default function App() {
  const { theme, sidebarCollapsed, toggleSidebar, hasCompletedOnboarding, activeTab, setActiveTab } = useAppStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inspectedStage, setInspectedStage] = useState<StageDetail | null>(null);

  // Poll server health every 5 seconds
  useHealthPoller(5000);

  const handleSettingsClick = useCallback(() => setSettingsOpen(true), []);
  const handleSettingsClose = useCallback(() => setSettingsOpen(false), []);
  const handleInspectorClose = useCallback(() => setInspectedStage(null), []);

  // Keyboard shortcuts: Ctrl+, for settings, Ctrl+1-4 for tabs
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key === ",") {
          e.preventDefault();
          setSettingsOpen((prev) => !prev);
        } else if (e.key === "1") {
          e.preventDefault();
          setActiveTab("chat");
        } else if (e.key === "2") {
          e.preventDefault();
          setActiveTab("dag");
        } else if (e.key === "3") {
          e.preventDefault();
          setActiveTab("graph");
        } else if (e.key === "4") {
          e.preventDefault();
          setActiveTab("ingestion");
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setActiveTab]);

  // Show onboarding wizard on first launch
  if (!hasCompletedOnboarding) {
    return (
      <div className={`app-root ${theme}`} data-theme={theme}>
        <ConnectionWizard />
      </div>
    );
  }

  return (
    <div className={`app-root ${theme}`} data-theme={theme}>
      <TopBar onSettingsClick={handleSettingsClick} />

      <div className="app-body">
        {/* Sidebar */}
        <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
          <button className="sidebar-toggle" onClick={toggleSidebar}>
            {sidebarCollapsed ? "▶" : "◀"}
          </button>
          {!sidebarCollapsed && (
            <>
              <SolutionList />
              <div className="sidebar-divider" />
              <ConversationTree />
              <div className="sidebar-divider" />
              <WorkflowLibrary />
            </>
          )}
        </aside>

        {/* Main content with tabs */}
        <div className="main-container">
          <TabBar />
          <main className="main-area">
            {activeTab === "chat" && <ChatPane />}
            {activeTab === "dag" && (
              <Suspense fallback={<TabFallback label="DAG Runner" />}>
                <ReactFlowProvider>
                  <WorkflowDAG />
                </ReactFlowProvider>
              </Suspense>
            )}
            {activeTab === "graph" && (
              <Suspense fallback={<TabFallback label="Graph Explorer" />}>
                <GraphExplorer />
              </Suspense>
            )}
            {activeTab === "ingestion" && (
              <Suspense fallback={<TabFallback label="File Ingestion" />}>
                <IngestionPanel />
              </Suspense>
            )}
          </main>
        </div>
      </div>

      <StatusBar />
      <CommandPalette />
      <SettingsDialog isOpen={settingsOpen} onClose={handleSettingsClose} />
      <StageInspector stage={inspectedStage} onClose={handleInspectorClose} />
    </div>
  );
}

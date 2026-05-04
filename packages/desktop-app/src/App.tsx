/**
 * MemFlow Desktop — Root Application
 */
import { useState, useCallback } from "react";
import { TopBar } from "./components/layout/TopBar";
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

export default function App() {
  const { theme, sidebarCollapsed, toggleSidebar, hasCompletedOnboarding } = useAppStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inspectedStage, setInspectedStage] = useState<StageDetail | null>(null);

  // Poll server health every 5 seconds
  useHealthPoller(5000);

  const handleSettingsClick = useCallback(() => setSettingsOpen(true), []);
  const handleSettingsClose = useCallback(() => setSettingsOpen(false), []);
  const handleInspectorClose = useCallback(() => setInspectedStage(null), []);

  // Keyboard shortcut: Ctrl+, for settings
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((prev) => !prev);
      }
    }, { once: true });
  }

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

        {/* Main content */}
        <main className="main-area">
          <ChatPane />
        </main>
      </div>

      <StatusBar />
      <CommandPalette />
      <SettingsDialog isOpen={settingsOpen} onClose={handleSettingsClose} />
      <StageInspector stage={inspectedStage} onClose={handleInspectorClose} />
    </div>
  );
}

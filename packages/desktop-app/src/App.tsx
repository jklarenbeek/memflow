/**
 * MemFlow Desktop — Root Application
 */
import { TopBar } from "./components/layout/TopBar";
import { StatusBar } from "./components/layout/StatusBar";
import { SolutionList } from "./components/sidebar/SolutionList";
import { ConversationTree } from "./components/sidebar/ConversationTree";
import { WorkflowLibrary } from "./components/sidebar/WorkflowLibrary";
import { ChatPane } from "./components/chat/ChatPane";
import { CommandPalette } from "./components/palette/CommandPalette";
import { useHealthPoller } from "./hooks/useMemFlowAPI";
import { useAppStore } from "./stores/appStore";
import "./App.css";

export default function App() {
  const { theme, sidebarCollapsed, toggleSidebar } = useAppStore();

  // Poll server health every 5 seconds
  useHealthPoller(5000);

  return (
    <div className={`app-root ${theme}`} data-theme={theme}>
      <TopBar />

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
    </div>
  );
}

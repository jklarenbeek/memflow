/**
 * TopBar — Solution switcher, status indicator, settings
 */
import { useSidecarStore } from "../../stores/sidecarStore";
import { useAppStore } from "../../stores/appStore";

export function TopBar() {
  const { status, version, moduleCount } = useSidecarStore();
  const { theme, setTheme } = useAppStore();

  const statusColors: Record<string, string> = {
    healthy: "bg-green-500",
    degraded: "bg-yellow-500",
    disconnected: "bg-red-500",
    starting: "bg-blue-500 animate-pulse",
    error: "bg-red-500",
  };

  return (
    <header className="topbar">
      <div className="topbar-left">
        <h1 className="topbar-title">MemFlow</h1>
        {version && <span className="topbar-version">v{version}</span>}
      </div>
      <div className="topbar-center">
        {moduleCount > 0 && (
          <span className="topbar-modules">{moduleCount} modules</span>
        )}
      </div>
      <div className="topbar-right">
        <div className="status-indicator" title={`Server: ${status}`}>
          <span className={`status-dot ${statusColors[status] ?? "bg-gray-500"}`} />
          <span className="status-label">{status}</span>
        </div>
        <button
          className="theme-toggle"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
      </div>
    </header>
  );
}

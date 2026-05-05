/**
 * TopBar — Solution switcher, health indicator, settings, theme toggle
 */
import { useSidecarStore } from "../../stores/sidecarStore";
import './TopBar.css';
import { useAppStore } from "../../stores/appStore";

interface Props {
  onSettingsClick?: () => void;
}

export function TopBar({ onSettingsClick }: Props) {
  const { status, version, moduleCount, health } = useSidecarStore();
  const { theme, setTheme } = useAppStore();

  const statusConfig: Record<string, { color: string; label: string }> = {
    healthy: { color: "var(--status-ok)", label: "Connected" },
    degraded: { color: "var(--status-warn)", label: "Degraded" },
    disconnected: { color: "var(--status-error)", label: "Disconnected" },
    starting: { color: "var(--status-info)", label: "Starting..." },
    error: { color: "var(--status-error)", label: "Error" },
  };

  const statusInfo = statusConfig[status] ?? statusConfig.disconnected;

  return (
    <header className="topbar">
      <div className="topbar-left">
        <h1 className="topbar-title">
          <span className="topbar-logo">◆</span>
          MemFlow
        </h1>
        {version && <span className="topbar-version">v{version}</span>}
      </div>

      <div className="topbar-center">
        {moduleCount > 0 && (
          <span className="topbar-modules">{moduleCount} modules</span>
        )}
        {health && (
          <div className="topbar-health-mini">
            <span className={`health-dot ${health.memgraph === "connected" ? "ok" : "err"}`} title={`Memgraph: ${health.memgraph}`} />
            <span className={`health-dot ${health.ollama === "reachable" ? "ok" : "err"}`} title={`Ollama: ${health.ollama}`} />
          </div>
        )}
      </div>

      <div className="topbar-right">
        <div className="status-indicator" title={`Server: ${status}`}>
          <span className="status-dot" style={{ backgroundColor: statusInfo.color }} />
          <span className="status-label">{statusInfo.label}</span>
        </div>

        <button
          className="topbar-btn"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? "☀️" : "🌙"}
        </button>

        <button
          className="topbar-btn"
          onClick={onSettingsClick}
          title="Settings (Ctrl+,)"
        >
          ⚙️
        </button>
      </div>
    </header>
  );
}

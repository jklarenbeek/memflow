/**
 * StatusBar — Dependency health, active workflows, version
 */
import { useSidecarStore } from "../../stores/sidecarStore";

export function StatusBar() {
  const { health, version } = useSidecarStore();

  const badge = (label: string, status: string, good: string) => (
    <span className={`statusbar-badge ${status === good ? "badge-ok" : "badge-warn"}`}>
      {label}: {status ?? "unknown"}
    </span>
  );

  return (
    <footer className="statusbar">
      <div className="statusbar-left">
        {health && (
          <>
            {badge("Memgraph", health.memgraph, "connected")}
            {badge("Ollama", health.ollama, "reachable")}
            {badge("Tavily", health.tavily, "configured")}
          </>
        )}
      </div>
      <div className="statusbar-right">
        {version && <span className="statusbar-version">MemFlow {version}</span>}
      </div>
    </footer>
  );
}

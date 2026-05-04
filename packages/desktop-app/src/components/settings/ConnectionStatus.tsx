/**
 * ConnectionStatus — Health badge component for TopBar/SettingsDialog
 */
import { useSidecarStore } from "../../stores/sidecarStore";

interface Props {
  compact?: boolean;
}

export function ConnectionStatus({ compact }: Props) {
  const { health, status, lastChecked } = useSidecarStore();

  if (!health) {
    return (
      <div className={`connection-status ${compact ? "compact" : ""}`}>
        <span className="health-dot err" />
        <span className="connection-label">{status === "starting" ? "Connecting..." : "Disconnected"}</span>
      </div>
    );
  }

  const services = [
    { name: "Memgraph", status: health.memgraph, good: "connected", icon: "🗄️" },
    { name: "Ollama", status: health.ollama, good: "reachable", icon: "🤖" },
    { name: "Tavily", status: health.tavily, good: "configured", icon: "🔍" },
  ];

  if (compact) {
    return (
      <div className="connection-status compact">
        {services.map((svc) => (
          <span
            key={svc.name}
            className={`health-dot ${svc.status === svc.good ? "ok" : "err"}`}
            title={`${svc.name}: ${svc.status}`}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="connection-status">
      {services.map((svc) => (
        <div key={svc.name} className={`connection-service ${svc.status === svc.good ? "ok" : "err"}`}>
          <span className="service-icon">{svc.icon}</span>
          <span className="service-name">{svc.name}</span>
          <span className={`service-status ${svc.status === svc.good ? "ok" : "err"}`}>
            {svc.status}
          </span>
        </div>
      ))}
      {lastChecked && (
        <span className="connection-checked">
          Last checked: {new Date(lastChecked).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}

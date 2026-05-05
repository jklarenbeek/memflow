import './Settings.css';
/**
 * SettingsDialog — Server URL, LLM provider, theme, workflow defaults
 */
import { useState, useEffect, useCallback } from "react";
import { useAppStore } from "../../stores/appStore";
import { useSidecarStore } from "../../stores/sidecarStore";
import { api } from "../../lib/api";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsDialog({ isOpen, onClose }: Props) {
  const { serverUrl, setServerUrl, theme, setTheme, connectionMode, setConnectionMode } = useAppStore();
  const { health, version } = useSidecarStore();

  const [localUrl, setLocalUrl] = useState(serverUrl);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [activeTab, setActiveTab] = useState<"connection" | "appearance" | "about">("connection");

  // Sync on open
  useEffect(() => {
    if (isOpen) {
      setLocalUrl(serverUrl);
      setTestStatus("idle");
    }
  }, [isOpen, serverUrl]);

  // Keyboard: Ctrl+, to open, Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  const testConnection = useCallback(async () => {
    setTestStatus("testing");
    try {
      api.setBaseUrl(localUrl);
      await api.health();
      setTestStatus("ok");
    } catch {
      setTestStatus("fail");
    }
  }, [localUrl]);

  const saveUrl = () => {
    setServerUrl(localUrl);
    setTestStatus("idle");
  };

  if (!isOpen) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose}>×</button>
        </div>

        <div className="settings-tabs">
          <button className={`settings-tab ${activeTab === "connection" ? "active" : ""}`}
            onClick={() => setActiveTab("connection")}>Connection</button>
          <button className={`settings-tab ${activeTab === "appearance" ? "active" : ""}`}
            onClick={() => setActiveTab("appearance")}>Appearance</button>
          <button className={`settings-tab ${activeTab === "about" ? "active" : ""}`}
            onClick={() => setActiveTab("about")}>About</button>
        </div>

        <div className="settings-body">
          {activeTab === "connection" && (
            <div className="settings-section">
              <div className="setting-group">
                <label className="setting-label">Server Mode</label>
                <div className="setting-radio-group">
                  <label className="setting-radio">
                    <input type="radio" checked={connectionMode === "sidecar"}
                      onChange={() => setConnectionMode("sidecar")} />
                    <span>Embedded (Sidecar)</span>
                    <span className="setting-hint">MemFlow starts automatically with the app</span>
                  </label>
                  <label className="setting-radio">
                    <input type="radio" checked={connectionMode === "external"}
                      onChange={() => setConnectionMode("external")} />
                    <span>External Server</span>
                    <span className="setting-hint">Connect to a running MemFlow instance</span>
                  </label>
                </div>
              </div>

              <div className="setting-group">
                <label className="setting-label">Server URL</label>
                <div className="setting-url-row">
                  <input
                    type="url" className="setting-input" value={localUrl}
                    onChange={(e) => { setLocalUrl(e.target.value); setTestStatus("idle"); }}
                    placeholder="http://127.0.0.1:3000"
                  />
                  <button className="btn-sm" onClick={testConnection}
                    disabled={testStatus === "testing"}>
                    {testStatus === "testing" ? "Testing..." :
                     testStatus === "ok" ? "✓ OK" :
                     testStatus === "fail" ? "✗ Failed" : "Test"}
                  </button>
                </div>
                {localUrl !== serverUrl && (
                  <button className="btn-sm btn-primary" onClick={saveUrl}
                    style={{ marginTop: "0.5rem" }}>Save URL</button>
                )}
              </div>

              {health && (
                <div className="setting-group">
                  <label className="setting-label">Service Health</label>
                  <div className="health-grid">
                    <span className={`health-badge ${health.memgraph === "connected" ? "ok" : "err"}`}>
                      Memgraph: {health.memgraph}
                    </span>
                    <span className={`health-badge ${health.ollama === "reachable" ? "ok" : "err"}`}>
                      Ollama: {health.ollama}
                    </span>
                    <span className={`health-badge ${health.tavily === "configured" ? "ok" : "err"}`}>
                      Tavily: {health.tavily}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === "appearance" && (
            <div className="settings-section">
              <div className="setting-group">
                <label className="setting-label">Theme</label>
                <div className="setting-radio-group">
                  <label className="setting-radio">
                    <input type="radio" checked={theme === "dark"} onChange={() => setTheme("dark")} />
                    <span>🌙 Dark</span>
                  </label>
                  <label className="setting-radio">
                    <input type="radio" checked={theme === "light"} onChange={() => setTheme("light")} />
                    <span>☀️ Light</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {activeTab === "about" && (
            <div className="settings-section">
              <div className="about-info">
                <h3>MemFlow Desktop</h3>
                <p className="about-tagline">Self-improving RAG and lifelong memory workflow engine</p>
                <div className="about-grid">
                  <span>Server Version</span>
                  <span>{version ?? "Not connected"}</span>
                  <span>Connection</span>
                  <span>{connectionMode === "sidecar" ? "Embedded Sidecar" : "External"}</span>
                  <span>Server URL</span>
                  <span>{serverUrl}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

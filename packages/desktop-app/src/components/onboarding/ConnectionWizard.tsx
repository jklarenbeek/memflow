import './Wizard.css';
/**
 * ConnectionWizard — First-launch onboarding flow
 *
 * Step 1: Server mode selection (sidecar vs external)
 * Step 2: Server URL + health check validation
 * Step 3: Solution creation
 * Step 4: Complete — set onboarding flag
 */
import { useState, useCallback } from "react";
import { useAppStore } from "../../stores/appStore";
import { api } from "../../lib/api";

type WizardStep = "mode" | "connect" | "solution" | "complete";

export function ConnectionWizard() {
  const {
    setConnectionMode, setServerUrl, setOnboardingComplete,
    setCurrentSolution, connectionMode, serverUrl,
  } = useAppStore();

  const [step, setStep] = useState<WizardStep>("mode");
  const [localUrl, setLocalUrl] = useState(serverUrl);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [solutionName, setSolutionName] = useState("");
  const [solutionDomain, setSolutionDomain] = useState("custom");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const testConnection = useCallback(async () => {
    setTestStatus("testing");
    setError(null);
    try {
      api.setBaseUrl(localUrl);
      await api.health();
      setTestStatus("ok");
    } catch {
      setTestStatus("fail");
      setError("Could not connect to the server. Make sure MemFlow is running.");
    }
  }, [localUrl]);

  const handleModeSelect = (mode: "sidecar" | "external") => {
    setConnectionMode(mode);
    if (mode === "sidecar") {
      setLocalUrl("http://127.0.0.1:3000");
    }
    setStep("connect");
  };

  const handleConnect = () => {
    setServerUrl(localUrl);
    setStep("solution");
  };

  const handleCreateSolution = async () => {
    if (!solutionName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      api.setBaseUrl(localUrl);
      const res = await api.createSolution({
        name: solutionName.trim(),
        domain: solutionDomain,
      });
      const sol = res.solution as Record<string, unknown>;
      setCurrentSolution(sol.id as string);
      setStep("complete");
    } catch (err) {
      setError(`Failed to create solution: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  const handleComplete = () => {
    setOnboardingComplete();
  };

  const handleSkipSolution = () => {
    setStep("complete");
  };

  return (
    <div className="wizard-overlay">
      <div className="wizard-container">
        {/* Progress indicator */}
        <div className="wizard-progress">
          {(["mode", "connect", "solution", "complete"] as WizardStep[]).map((s, i) => (
            <div key={s} className={`wizard-step-dot ${step === s ? "active" : i < ["mode", "connect", "solution", "complete"].indexOf(step) ? "done" : ""}`} />
          ))}
        </div>

        {/* Step 1: Mode Selection */}
        {step === "mode" && (
          <div className="wizard-step">
            <div className="wizard-hero">
              <h1>Welcome to MemFlow</h1>
              <p>Self-improving RAG and lifelong memory workflow engine</p>
            </div>
            <h2>How would you like to connect?</h2>
            <div className="wizard-mode-cards">
              <button className="wizard-card" onClick={() => handleModeSelect("sidecar")}>
                <span className="wizard-card-icon">🚀</span>
                <h3>Embedded (Recommended)</h3>
                <p>MemFlow server starts automatically with the app. No setup needed.</p>
              </button>
              <button className="wizard-card" onClick={() => handleModeSelect("external")}>
                <span className="wizard-card-icon">🔗</span>
                <h3>External Server</h3>
                <p>Connect to an existing MemFlow server running elsewhere.</p>
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Connection Test */}
        {step === "connect" && (
          <div className="wizard-step">
            <h2>Connect to MemFlow</h2>
            <p>
              {connectionMode === "sidecar"
                ? "The embedded server will start on this URL:"
                : "Enter the URL of your MemFlow server:"}
            </p>
            <div className="wizard-url-group">
              <input
                type="url" className="wizard-input" value={localUrl}
                onChange={(e) => { setLocalUrl(e.target.value); setTestStatus("idle"); }}
                placeholder="http://127.0.0.1:3000"
              />
              <button className="btn-primary" onClick={testConnection}
                disabled={testStatus === "testing"}>
                {testStatus === "testing" ? "Testing..." : "Test Connection"}
              </button>
            </div>

            {testStatus === "ok" && (
              <div className="wizard-feedback ok">
                <span>✓</span> Connected successfully!
              </div>
            )}
            {error && (
              <div className="wizard-feedback error">
                <span>✗</span> {error}
              </div>
            )}

            <div className="wizard-actions">
              <button className="btn-ghost" onClick={() => setStep("mode")}>Back</button>
              <button className="btn-primary" onClick={handleConnect}
                disabled={testStatus !== "ok"}>Continue</button>
            </div>
          </div>
        )}

        {/* Step 3: Solution Creation */}
        {step === "solution" && (
          <div className="wizard-step">
            <h2>Create Your First Solution</h2>
            <p>Solutions are isolated workspaces for different projects or domains.</p>

            <div className="wizard-form">
              <div className="setting-group">
                <label className="setting-label">Solution Name</label>
                <input
                  type="text" className="wizard-input" value={solutionName}
                  onChange={(e) => setSolutionName(e.target.value)}
                  placeholder="My Research Project"
                  autoFocus
                />
              </div>
              <div className="setting-group">
                <label className="setting-label">Domain</label>
                <select className="wizard-select" value={solutionDomain}
                  onChange={(e) => setSolutionDomain(e.target.value)}>
                  <option value="custom">Custom</option>
                  <option value="research">Research</option>
                  <option value="trading">Trading</option>
                  <option value="engineering">Engineering</option>
                  <option value="creative">Creative</option>
                </select>
              </div>
            </div>

            {error && <div className="wizard-feedback error"><span>✗</span> {error}</div>}

            <div className="wizard-actions">
              <button className="btn-ghost" onClick={() => setStep("connect")}>Back</button>
              <button className="btn-ghost" onClick={handleSkipSolution}>Skip</button>
              <button className="btn-primary" onClick={handleCreateSolution}
                disabled={!solutionName.trim() || creating}>
                {creating ? "Creating..." : "Create Solution"}
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Complete */}
        {step === "complete" && (
          <div className="wizard-step">
            <div className="wizard-hero">
              <span className="wizard-complete-icon">🎉</span>
              <h2>You're All Set!</h2>
              <p>MemFlow is ready. Start a conversation to explore your knowledge graph.</p>
            </div>
            <div className="wizard-actions centered">
              <button className="btn-primary btn-lg" onClick={handleComplete}>
                Get Started
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

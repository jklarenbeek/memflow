import './SolutionWizard.css';
/**
 * SolutionWizard — 4-step domain-scoped Solution creation wizard
 *
 * Steps:
 *   1. Name & Description
 *   2. Domain Selection (Trading, Research, Healthcare, Legal, Custom)
 *   3. LLM Configuration (provider + model)
 *   4. Review & Create
 */
import { useState, useCallback } from "react";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/appStore";

const DOMAINS = [
  { id: "trading", icon: "📈", name: "Trading", desc: "Financial analysis, market research, portfolio management" },
  { id: "research", icon: "📚", name: "Research", desc: "Academic papers, literature review, knowledge synthesis" },
  { id: "healthcare", icon: "🏥", name: "Healthcare", desc: "Medical records, clinical data, patient insights" },
  { id: "legal", icon: "⚖️", name: "Legal", desc: "Contract analysis, case law, compliance review" },
  { id: "engineering", icon: "🔧", name: "Engineering", desc: "Technical documentation, code analysis, architecture" },
  { id: "custom", icon: "⚙️", name: "Custom", desc: "Configure your own domain from scratch" },
];

interface SolutionWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (solution: Record<string, unknown>) => void;
}

export function SolutionWizard({ isOpen, onClose, onCreated }: SolutionWizardProps) {
  const { setCurrentSolution } = useAppStore();
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [domain, setDomain] = useState("custom");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await api.createSolution({
        name: name.trim(),
        description: description.trim() || undefined,
        domain,
      });
      const sol = res.solution as { id: string };
      setCurrentSolution(sol.id);
      onCreated?.(res.solution);
      onClose();
      // Reset wizard
      setStep(1);
      setName("");
      setDescription("");
      setDomain("custom");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [name, description, domain, setCurrentSolution, onCreated, onClose]);

  const handleClose = useCallback(() => {
    onClose();
    setStep(1);
    setName("");
    setDescription("");
    setDomain("custom");
    setError(null);
  }, [onClose]);

  if (!isOpen) return null;

  return (
    <div className="solution-wizard-overlay" onClick={handleClose}>
      <div className="solution-wizard" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="settings-header">
          <h2>Create Solution</h2>
          <button className="settings-close" onClick={handleClose}>×</button>
        </div>

        {/* Progress */}
        <div className="wizard-progress" style={{ padding: "12px 20px" }}>
          {[1, 2, 3, 4].map((s) => (
            <div
              key={s}
              className={`wizard-step-dot ${s === step ? "active" : s < step ? "done" : ""}`}
            />
          ))}
        </div>

        {/* Body */}
        <div className="settings-body">
          {/* Step 1: Name */}
          {step === 1 && (
            <div className="wizard-step">
              <h2>Name your solution</h2>
              <p>Give your solution a descriptive name and optional description.</p>
              <div className="wizard-form">
                <div className="setting-group">
                  <label className="setting-label">Name *</label>
                  <input
                    className="wizard-input"
                    placeholder="e.g. Market Research Q2"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="setting-group">
                  <label className="setting-label">Description</label>
                  <input
                    className="wizard-input"
                    placeholder="What is this solution for?"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Domain */}
          {step === 2 && (
            <div className="wizard-step">
              <h2>Choose a domain</h2>
              <p>Select a domain to pre-configure workflows, roles, and entity schemas.</p>
              <div className="wizard-domain-grid">
                {DOMAINS.map((d) => (
                  <div
                    key={d.id}
                    className={`domain-card ${domain === d.id ? "selected" : ""}`}
                    onClick={() => setDomain(d.id)}
                  >
                    <span className="domain-card-icon">{d.icon}</span>
                    <h3>{d.name}</h3>
                    <p>{d.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 3: Config */}
          {step === 3 && (
            <div className="wizard-step">
              <h2>Configuration</h2>
              <p>These settings can be changed later in Solution settings.</p>
              <div className="wizard-form">
                <div className="setting-group">
                  <label className="setting-label">LLM Provider</label>
                  <select className="wizard-select" defaultValue="ollama">
                    <option value="ollama">Ollama (Local)</option>
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                </div>
                <div className="setting-group">
                  <label className="setting-label">Default Model</label>
                  <select className="wizard-select" defaultValue="gemma3">
                    <option value="gemma3">gemma3 (Ollama)</option>
                    <option value="llama3.1">llama3.1 (Ollama)</option>
                    <option value="mistral">mistral (Ollama)</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Step 4: Review */}
          {step === 4 && (
            <div className="wizard-step">
              <h2>Review & Create</h2>
              <div className="about-grid" style={{ margin: "16px 0" }}>
                <span>Name</span>
                <span>{name}</span>
                <span>Domain</span>
                <span>{DOMAINS.find((d) => d.id === domain)?.name ?? domain}</span>
                <span>Description</span>
                <span>{description || "—"}</span>
              </div>
              {error && (
                <div className="wizard-feedback error">⚠️ {error}</div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="wizard-actions" style={{ padding: "16px 20px", borderTop: "1px solid var(--border)" }}>
          {step > 1 && (
            <button className="btn-ghost" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <div style={{ flex: 1 }} />
          {step < 4 ? (
            <button
              className="btn-primary"
              onClick={() => setStep(step + 1)}
              disabled={step === 1 && !name.trim()}
            >
              Next
            </button>
          ) : (
            <button className="btn-primary" onClick={handleCreate} disabled={creating}>
              {creating ? "Creating…" : "Create Solution"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

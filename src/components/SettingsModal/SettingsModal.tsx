import React, { useEffect, useId, useRef, useState } from "react";
import { Check, ExternalLink, HardDrive, Key, Loader2, ScrollText, Shield, Sparkles, Terminal, X } from "lucide-react";
import { VaultConfig, DetectedAgentCli } from "../../types";
import { TauriBridge, isTauriEnvironment } from "../../services/tauri/bridge";
import "./SettingsModal.css";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  vault: VaultConfig;
  onSaveVault: (updated: VaultConfig) => Promise<boolean>;
  embedded?: boolean;
}

type SaveState = "idle" | "saving" | "saved" | "error";
type CliScan = { state: "loading" | "error" } | { state: "done"; clis: DetectedAgentCli[] };
type AuditCheck =
  | { state: "idle" | "checking" }
  | { state: "done"; result: Awaited<ReturnType<typeof TauriBridge.verifyAuditLog>> }
  | { state: "error"; message: string };

const sections = [
  { id: "providers", label: "Providers", Icon: Sparkles },
  { id: "cli", label: "Local agents", Icon: Terminal },
  { id: "permissions", label: "Permissions", Icon: Shield },
] as const;

const apiProviders = [
  { key: "anthropicApiKey", name: "Anthropic", url: "https://console.anthropic.com/settings/keys", color: "", placeholder: "sk-ant-api03-..." },
  { key: "openaiApiKey", name: "OpenAI", url: "https://platform.openai.com/api-keys", color: "green", placeholder: "sk-proj-..." },
  { key: "grokApiKey", name: "xAI (Grok)", url: "https://console.x.ai/", color: "gray", placeholder: "xai-..." },
] as const;

const defaultOllamaUrl = "http://localhost:11434";
const draftFromVault = (vault: VaultConfig) => ({
  anthropicApiKey: vault.anthropicApiKey ?? "",
  openaiApiKey: vault.openaiApiKey ?? "",
  grokApiKey: vault.grokApiKey ?? "",
  ollamaBaseUrl: vault.ollamaBaseUrl || defaultOllamaUrl,
  autoApproveSafeTools: vault.autoApproveSafeTools ?? true,
});

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  vault,
  onSaveVault,
  embedded = false,
}) => {
  const desktop = isTauriEnvironment();
  const [draft, setDraft] = useState(() => draftFromVault(vault));
  const [tab, setTab] = useState<(typeof sections)[number]["id"]>("providers");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [scan, setScan] = useState<CliScan>({ state: "loading" });
  const [scanAttempt, setScanAttempt] = useState(0);
  const [auditCheck, setAuditCheck] = useState<AuditCheck>({ state: "idle" });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const saveRequest = useRef(0);
  const id = useId();

  useEffect(() => setDraft(draftFromVault(vault)), [vault, isOpen]);
  useEffect(() => () => { saveRequest.current += 1; }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setSaveState("idle");
      setTab("providers");
      return;
    }
    if (!desktop) return;
    let active = true;
    setScan({ state: "loading" });
    TauriBridge.detectAgentClis().then(
      (clis) => { if (active) setScan({ state: "done", clis }); },
      () => { if (active) setScan({ state: "error" }); },
    );
    return () => { active = false; };
  }, [desktop, isOpen, scanAttempt]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) dialog.showModal();
    if (!isOpen && dialog.open) dialog.close();
  }, [embedded, isOpen]);

  useEffect(() => {
    if (embedded || !isOpen || saveState !== "saved") return;
    const timeout = window.setTimeout(onClose, 600);
    return () => window.clearTimeout(timeout);
  }, [embedded, isOpen, onClose, saveState]);

  const updateDraft = <K extends keyof typeof draft,>(key: K, value: (typeof draft)[K]) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setSaveState("idle");
  };

  const saveUnavailable = saveState === "saving" || saveState === "saved";

  const handleSave = async () => {
    if (saveUnavailable) return;
    const request = ++saveRequest.current;
    setSaveState("saving");
    try {
      const ok = await onSaveVault({
        ...vault,
        anthropicApiKey: draft.anthropicApiKey.trim(),
        openaiApiKey: draft.openaiApiKey.trim(),
        grokApiKey: draft.grokApiKey.trim(),
        ollamaBaseUrl: draft.ollamaBaseUrl.trim(),
        autoApproveSafeTools: draft.autoApproveSafeTools,
      });
      if (request === saveRequest.current) setSaveState(ok ? "saved" : "error");
    } catch {
      if (request === saveRequest.current) setSaveState("error");
    }
  };

  const verifyAudit = async () => {
    if (!desktop || auditCheck.state === "checking") return;
    setAuditCheck({ state: "checking" });
    try {
      const result = await TauriBridge.verifyAuditLog();
      setAuditCheck({ state: "done", result });
    } catch (error) {
      setAuditCheck({ state: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const saving = saveState === "saving";
  const providers = (
    <section className="settings-section" aria-labelledby={`${id}-providers`}>
      <h2 id={`${id}-providers`}>Your model connections</h2>
      <p>{desktop ? "Enter the API keys or local endpoint you want AnyBot to use." : "Set your local endpoint here. Use the desktop app to configure API keys."}</p>
      {apiProviders.map(({ key, name, url, color, placeholder }) => (
        <div className="provider-card anybot-provider-field" key={key}>
          <span className={`provider-logo ${color}`} aria-hidden="true"><Key className="icon" /></span>
          <div className="min-w-0 grow"><h3>{name}</h3><p>Direct API</p></div>
          <a className="btn" href={url} target="_blank" rel="noreferrer" aria-label={`Get ${name} API key (opens in a new tab)`}>
            Get key <ExternalLink className="icon" aria-hidden="true" />
          </a>
          <div className="field anybot-provider-input">
            <label htmlFor={`${id}-${key}`}>{name} API key</label>
            <input id={`${id}-${key}`} type="password" autoComplete="off" value={desktop ? draft[key] : ""} disabled={saving || !desktop}
              onChange={(event) => updateDraft(key, event.target.value)} placeholder={placeholder} />
          </div>
        </div>
      ))}
      <div className="provider-card anybot-provider-field">
        <span className="provider-logo purple" aria-hidden="true"><HardDrive className="icon" /></span>
        <div className="min-w-0 grow"><h3>Ollama</h3><p>Local endpoint</p></div>
        <div className="field anybot-provider-input">
          <label htmlFor={`${id}-ollama`}>Ollama endpoint</label>
          <input id={`${id}-ollama`} type="url" value={draft.ollamaBaseUrl} disabled={saving}
            aria-describedby={`${id}-ollama-note`} onChange={(event) => updateDraft("ollamaBaseUrl", event.target.value)} placeholder={defaultOllamaUrl} />
          <small id={`${id}-ollama-note`}>AnyBot checks availability when you send a message. File and command tasks require a model that supports tools.</small>
        </div>
      </div>
      <div className="info-banner anybot-settings-note">
        <Shield className="icon" aria-hidden="true" />
        <span>{!desktop ? "API keys are not stored in this browser preview." : vault.keychainStorageActive === true
          ? "API keys are protected by the OS keychain."
          : vault.keychainStorageActive === false
            ? "API keys use protected file storage (mode 0600, restricted to owner)."
            : "API key storage status is not available yet."}</span>
      </div>
    </section>
  );

  const localAgents = (
    <section className="settings-section" aria-labelledby={`${id}-cli`}>
      <h2 id={`${id}-cli`}>Bring the tools you already use.</h2>
      <p>AnyBot detects installed agent CLIs and can use them to run local agents. Detection does not confirm authentication.</p>
      {!desktop && <p role="status">Detecting installed agent CLIs requires the desktop app.</p>}
      {desktop && scan.state === "loading" && <p role="status">Looking for installed agent CLIs…</p>}
      {scan.state === "error" && (
        <div className="info-banner anybot-settings-note"><p role="alert">Could not check installed agent CLIs.</p>
          <button type="button" className="btn shrink-0" onClick={() => setScanAttempt((attempt) => attempt + 1)}>Retry</button>
        </div>
      )}
      {scan.state === "done" && (scan.clis.length ? scan.clis.map((cli) => (
        <div key={cli.engine} className="provider-card anybot-cli-card">
          <span className="provider-logo gray" aria-hidden="true"><Terminal className="icon" /></span>
          <div className="min-w-0 grow break-words">
            <h3>{cli.name}</h3>
            <p><code>{cli.binary}</code>{cli.is_installed && (cli.version || cli.path) ? ` · ${cli.version || cli.path}` : ""}</p>
          </div>
          <span className={`tag ${cli.is_installed ? "green" : "neutral"}`}>{cli.is_installed ? "Installed" : "Not detected"}</span>
        </div>
      )) : <p role="status">No agent CLIs reported.</p>)}
      <div className="info-banner anybot-settings-note"><Terminal className="icon" aria-hidden="true" />
        <p>CLI access may use a subscription or other provider billing. Usage limits and permissions depend on the CLI.</p>
      </div>
    </section>
  );

  const permissions = (
    <section className="settings-section" aria-labelledby={`${id}-permissions`}>
      <h2 id={`${id}-permissions`}>A helpful agent. Clear boundaries.</h2>
      <p>Control automatic approval for read-only commands and verify the local audit log.</p>
      <div className="settings-row anybot-permission-row">
        <div className="min-w-0 grow">
          <span id={`${id}-approve`} className="anybot-setting-label">Auto-approve safe commands</span>
          <p id={`${id}-approve-note`}>Auto-approval for eligible read-only shell commands requires this and the agent’s switch to be on. Standing grants are handled separately; file writes always ask.</p>
        </div>
        <button type="button" className={`toggle ${draft.autoApproveSafeTools ? "on" : ""}`} role="switch"
          aria-checked={draft.autoApproveSafeTools} aria-labelledby={`${id}-approve`} aria-describedby={`${id}-approve-note`}
          disabled={saving} onClick={() => updateDraft("autoApproveSafeTools", !draft.autoApproveSafeTools)} />
      </div>
      <div className="settings-row anybot-permission-row">
        <div className="min-w-0 grow">
          <span className="anybot-setting-label">Audit log integrity</span>
          <p role="status" className="break-words">
            {!desktop ? "Audit verification requires the desktop app." : auditCheck.state === "checking" ? "Verifying the audit chain…" : auditCheck.state === "done" ? (
              auditCheck.result.valid
                ? `Audit chain intact — ${auditCheck.result.hashed_rows} verified ${auditCheck.result.hashed_rows === 1 ? "row" : "rows"}${auditCheck.result.legacy_rows > 0 ? ` (+${auditCheck.result.legacy_rows} pre-chain)` : ""}.`
                : <span className="text-danger">Audit chain broken at row {auditCheck.result.first_break ?? "unknown"}.</span>
            ) : auditCheck.state === "error" ? (
              <span className="text-danger">Could not verify the audit log: {auditCheck.message}</span>
            ) : "Check the tamper-evident chain that links audit entries."}
          </p>
        </div>
        <button type="button" className="btn shrink-0" disabled={!desktop || auditCheck.state === "checking"} onClick={verifyAudit}>
          <ScrollText className="icon" aria-hidden="true" /> Verify
        </button>
      </div>
    </section>
  );

  const actions = (
    <>
      {saveState === "error" && <p className="anybot-save-error text-danger" role="alert">Unable to save settings. Check that storage is available, then try again.</p>}
      {!embedded && <button type="button" className="btn" onClick={onClose}>Cancel</button>}
      <button type="button" className="btn primary" onClick={handleSave} aria-disabled={saveUnavailable}>
        {saving ? <><Loader2 className="icon motion-safe:animate-spin" aria-hidden="true" /> Saving…</>
          : saveState === "saved" ? <><Check className="icon" aria-hidden="true" /> Saved</> : "Save changes"}
      </button>
      <span className="sr-only" role="status">{saving ? "Saving settings" : saveState === "saved" ? "Settings saved" : ""}</span>
    </>
  );

  if (embedded) {
    if (!isOpen) return null;
    return (
      <section className="page anybot-settings" aria-labelledby={`${id}-title`}>
        <header className="page-header">
          <div className="grow">
            <div className="eyebrow">Make yourself at home</div>
            <h1 id={`${id}-title`}>Your workspace, your way.</h1>
            <p>Manage model connections, local agents, and permissions.</p>
          </div>
        </header>
        <div className="page-body">
          <div className="settings-layout">
            <nav className="settings-tabs" aria-label="Settings sections">
              {sections.map(({ id: section, label, Icon }) => (
                <button key={section} type="button" className={tab === section ? "active" : undefined}
                  aria-current={tab === section ? "true" : undefined} onClick={() => setTab(section)}>
                  <Icon className="icon" aria-hidden="true" /> {label}
                </button>
              ))}
            </nav>
            <div className="min-w-0">
              {tab === "providers" ? providers : tab === "cli" ? localAgents : permissions}
              <footer className="anybot-settings-actions">{actions}</footer>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <dialog ref={dialogRef} aria-labelledby={`${id}-title`} className="anybot-settings-dialog"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
      <div className="modal anybot-settings select-text">
        <header className="modal-head">
          <div><h2 id={`${id}-title`}>Settings &amp; API keys</h2><p>Manage model connections, local agents, and permissions.</p></div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings"><X className="icon" aria-hidden="true" /></button>
        </header>
        <div className="modal-body anybot-settings-sections">{providers}{localAgents}{permissions}</div>
        <footer className="modal-footer anybot-settings-actions">{actions}</footer>
      </div>
    </dialog>
  );
};

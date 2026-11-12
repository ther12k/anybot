import React, { useEffect, useRef, useState } from "react";
import { X, Key, Shield, HardDrive, Check, ExternalLink, Loader2 } from "lucide-react";
import { VaultConfig } from "../../types";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  vault: VaultConfig;
  onSaveVault: (updated: VaultConfig) => Promise<boolean>;
}

type SaveState = "idle" | "saving" | "saved" | "error";

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  vault,
  onSaveVault,
}) => {
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [grokApiKey, setGrokApiKey] = useState("");
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState("http://localhost:11434");
  const [autoApproveSafeTools, setAutoApproveSafeTools] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDialogElement>(null);

  // Drafts always start from the latest loaded vault — fixes overwriting
  // persisted keys with empty values when the async load was still in flight.
  useEffect(() => {
    setAnthropicApiKey(vault.anthropicApiKey || "");
    setOpenaiApiKey(vault.openaiApiKey || "");
    setGrokApiKey(vault.grokApiKey || "");
    setOllamaBaseUrl(vault.ollamaBaseUrl || "http://localhost:11434");
    setAutoApproveSafeTools(vault.autoApproveSafeTools ?? true);
    setSaveState("idle");
    setSaveError(null);
  }, [isOpen, vault]);

  // Native modal semantics: showModal() traps focus, Escape fires `cancel`
  // and closes, and the `close` event tells React to flip isOpen.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (isOpen && !d.open) d.showModal();
    if (!isOpen && d.open) d.close();
  }, [isOpen]);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    const handleClose = () => {
      onClose();
      // Return focus to the trigger so keyboard users don't land on <body>
      document.getElementById("anybot-settings-trigger")?.focus();
    };
    // Escape fallback: some webviews don't fire native `cancel` for
    // programmatic key events, so listen for the key directly too.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    d.addEventListener("close", handleClose);
    d.addEventListener("keydown", onKey);
    return () => {
      d.removeEventListener("close", handleClose);
      d.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const handleSave = async () => {
    setSaveState("saving");
    setSaveError(null);
    const ok = await onSaveVault({
      ...vault,
      anthropicApiKey: anthropicApiKey.trim(),
      openaiApiKey: openaiApiKey.trim(),
      grokApiKey: grokApiKey.trim(),
      ollamaBaseUrl: ollamaBaseUrl.trim(),
      autoApproveSafeTools,
    });
    if (ok) {
      setSaveState("saved");
      setTimeout(onClose, 600);
    } else {
      setSaveState("error");
      setSaveError(
        "Unable to save settings. Check that ~/.config/anybot/config.json is writable, then try again."
      );
    }
  };

  const inputCls =
    "w-full h-9 px-3 rounded-xl bg-sidebar border border-stroke text-primary font-mono text-xs placeholder:text-quaternary focus:outline-none focus:border-strokeStrong focus-visible:ring-2 focus-visible:ring-accent select-text";

  const labelCls = "font-semibold text-secondary";

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="settings-title"
      className="w-[calc(100%-2rem)] max-w-lg bg-chrome border border-stroke rounded-2xl shadow-xl overflow-hidden"
    >
      <div className="flex flex-col select-text">
        {/* Header */}
        <div className="px-5 h-12 border-b border-stroke flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-accent" aria-hidden="true" />
            <h3 id="settings-title" className="text-sm font-semibold text-primary">
              Settings &amp; API keys
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-tertiary hover:text-primary rounded-lg hover:bg-hover transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label="Close settings"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 text-xs max-h-[70vh] overflow-y-auto overscroll-contain">
          {/* Anthropic */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="anthropic-key" className={labelCls}>
                Anthropic API key
              </label>
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noreferrer"
                className="text-xxs text-accent hover:underline flex items-center gap-0.5"
              >
                Get key <ExternalLink className="w-3 h-3" aria-hidden="true" />
              </a>
            </div>
            <input
              id="anthropic-key"
              type="password"
              autoComplete="off"
              value={anthropicApiKey}
              onChange={(e) => setAnthropicApiKey(e.target.value)}
              placeholder="sk-ant-api03-..."
              className={inputCls}
            />
          </div>

          {/* OpenAI */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="openai-key" className={labelCls}>
                OpenAI API key
              </label>
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noreferrer"
                className="text-xxs text-accent hover:underline flex items-center gap-0.5"
              >
                Get key <ExternalLink className="w-3 h-3" aria-hidden="true" />
              </a>
            </div>
            <input
              id="openai-key"
              type="password"
              autoComplete="off"
              value={openaiApiKey}
              onChange={(e) => setOpenaiApiKey(e.target.value)}
              placeholder="sk-proj-..."
              className={inputCls}
            />
          </div>

          {/* xAI */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="grok-key" className={labelCls}>
                xAI (Grok) API key
              </label>
              <a
                href="https://console.x.ai/"
                target="_blank"
                rel="noreferrer"
                className="text-xxs text-accent hover:underline flex items-center gap-0.5"
              >
                Get key <ExternalLink className="w-3 h-3" aria-hidden="true" />
              </a>
            </div>
            <input
              id="grok-key"
              type="password"
              autoComplete="off"
              value={grokApiKey}
              onChange={(e) => setGrokApiKey(e.target.value)}
              placeholder="xai-..."
              className={inputCls}
            />
          </div>

          {/* Ollama */}
          <div className="space-y-1.5">
            <label htmlFor="ollama-url" className={`${labelCls} flex items-center gap-1.5`}>
              <HardDrive className="w-3.5 h-3.5 text-tertiary" aria-hidden="true" />
              Ollama endpoint (offline models)
            </label>
            <input
              id="ollama-url"
              type="url"
              value={ollamaBaseUrl}
              onChange={(e) => setOllamaBaseUrl(e.target.value)}
              placeholder="http://localhost:11434"
              className={inputCls}
            />
            <p className="text-xxs text-quaternary">
              Detected locally: phi3:mini is available. Pull deepseek-r1 or
              llama3.3 for tool calling.
            </p>
          </div>

          {/* Safety */}
          <div className="p-3.5 rounded-xl bg-sidebar border border-stroke flex items-center justify-between gap-3">
            <div>
              <div
                id="auto-approve-label"
                className="flex items-center gap-1.5 font-semibold text-secondary mb-0.5"
              >
                <Shield className="w-3.5 h-3.5 text-success" aria-hidden="true" />
                <span>Auto-approve safe commands</span>
              </div>
              <p className="text-xxs text-quaternary leading-relaxed">
                Read-only commands run automatically; changes always ask first.
              </p>
            </div>
            <button
              onClick={() => setAutoApproveSafeTools(!autoApproveSafeTools)}
              role="switch"
              aria-checked={autoApproveSafeTools}
              aria-labelledby="auto-approve-label"
              className={`w-9 h-5 rounded-full transition-colors relative shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                autoApproveSafeTools ? "bg-success" : "bg-strokeStrong"
              }`}
            >
              <div
                className={`w-4 h-4 rounded-full bg-white absolute top-0.5 transition-all ${
                  autoApproveSafeTools ? "left-[18px]" : "left-0.5"
                }`}
              />
            </button>
          </div>

          {/* Save failure — names the recovery path */}
          {saveError && (
            <p role="alert" className="text-xxs text-danger leading-relaxed">
              {saveError}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-stroke bg-sidebar flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-xl border border-stroke bg-elevated hover:bg-elevatedHover text-secondary font-medium text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saveState === "saving"}
            className="px-4 py-1.5 rounded-xl bg-bubbleUser hover:bg-[#333] text-white font-medium text-xs flex items-center gap-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
          >
            {saveState === "saving" ? (
              <>
                <Loader2 className="w-3.5 h-3.5 motion-safe:animate-spin" aria-hidden="true" />
                <span>Saving…</span>
              </>
            ) : saveState === "saved" ? (
              <>
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Saved</span>
              </>
            ) : (
              <span>Save changes</span>
            )}
          </button>
        </div>
      </div>
    </dialog>
  );
};

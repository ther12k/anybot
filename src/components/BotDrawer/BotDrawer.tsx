import React, { useState, useEffect, useId, useRef } from "react";
import { Check, Shield, Sliders, Wrench, X } from "lucide-react";
import { BotPersona } from "../../types";
import "./BotDrawer.css";

interface BotDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  bot: BotPersona;
  onUpdateBot: (updated: BotPersona) => void;
}

export const BotDrawer: React.FC<BotDrawerProps> = ({
  isOpen,
  onClose,
  bot,
  onUpdateBot,
}) => {
  const [name, setName] = useState(bot.name);
  const [description, setDescription] = useState(bot.description);
  const [avatar, setAvatar] = useState(bot.avatar);
  const [systemPrompt, setSystemPrompt] = useState(bot.systemPrompt);
  const [temperature, setTemperature] = useState(bot.temperature);
  const [autoApproveSafeTools, setAutoApproveSafeTools] = useState(bot.autoApproveSafeTools);
  const [isSaved, setIsSaved] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const id = useId();

  // Drafts reset from the live bot whenever the editor opens or the bot changes.
  useEffect(() => {
    setName(bot.name);
    setDescription(bot.description);
    setAvatar(bot.avatar);
    setSystemPrompt(bot.systemPrompt);
    setTemperature(bot.temperature);
    setAutoApproveSafeTools(bot.autoApproveSafeTools);
  }, [bot, isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    setIsSaved(false);
    if (dialog && isOpen && !dialog.open) {
      dialog.showModal();
      nameInputRef.current?.focus();
    } else if (dialog?.open && !isOpen) {
      dialog.close();
    }
  }, [isOpen]);

  const handleSave = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onUpdateBot({ ...bot, name, description, avatar, systemPrompt, temperature, autoApproveSafeTools });
    setIsSaved(true);
  };

  return (
    <dialog ref={dialogRef} aria-labelledby={`${id}-title`} className="anybot-agent-dialog"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
      <form className="modal select-text" onChange={() => setIsSaved(false)} onSubmit={handleSave}>
        <header className="modal-head">
          <div>
            <h2 id={`${id}-title`}>Make this agent your own.</h2>
            <p>Give your agent a clear purpose and a helpful set of instructions.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close agent configuration"><X className="icon" aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          <div className="anybot-agent-identity">
            <div className="field">
              <label htmlFor={`${id}-name`}>Name</label>
              <input id={`${id}-name`} ref={nameInputRef} value={name} onChange={(event) => setName(event.target.value)} placeholder="Agent name" />
            </div>
            <div className="field anybot-agent-avatar">
              <label htmlFor={`${id}-avatar`}>Avatar</label>
              <input id={`${id}-avatar`} value={avatar} onChange={(event) => setAvatar(event.target.value)} />
            </div>
          </div>
          <div className="field anybot-agent-description">
            <label htmlFor={`${id}-description`}>What does it help with?</label>
            <textarea id={`${id}-description`} value={description} rows={2} onChange={(event) => setDescription(event.target.value)} placeholder="A short, useful description" />
          </div>
          <div className="field">
            <label htmlFor={`${id}-instructions`}>System prompt</label>
            <textarea id={`${id}-instructions`} value={systemPrompt} rows={6} onChange={(event) => setSystemPrompt(event.target.value)}
              aria-describedby={`${id}-instructions-note`} placeholder="Describe its role, how it should help, and its boundaries…" />
            <small id={`${id}-instructions-note`}>Persona instructions never override tool policy or human approval.</small>
          </div>
          <div className="anybot-agent-slider">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={`${id}-temperature`} className="anybot-agent-label">
                <Sliders className="icon" aria-hidden="true" /> Temperature
              </label>
              <span className="font-mono" aria-hidden="true">{temperature.toFixed(2)}</span>
            </div>
            <input id={`${id}-temperature`} type="range" min="0" max="1" step="0.05" value={temperature}
              onChange={(event) => setTemperature(parseFloat(event.target.value))} />
            <div className="flex justify-between gap-2 text-xxs text-tertiary" aria-hidden="true">
              <span>Precise</span><span>Balanced</span><span>Creative</span>
            </div>
          </div>
          <div className="settings-row anybot-agent-permission">
            <div className="min-w-0 grow">
              <span id={`${id}-approve`} className="anybot-agent-label"><Shield className="icon" aria-hidden="true" /> Auto-run safe commands</span>
              <p id={`${id}-approve-note`}>Auto-approval for eligible read-only shell commands requires this and the global switch in Settings to be on. Standing grants are handled separately; file writes always ask.</p>
            </div>
            <button type="button" className={`toggle ${autoApproveSafeTools ? "on" : ""}`} role="switch"
              aria-checked={autoApproveSafeTools} aria-labelledby={`${id}-approve`} aria-describedby={`${id}-approve-note`}
              onClick={() => { setAutoApproveSafeTools(!autoApproveSafeTools); setIsSaved(false); }} />
          </div>
          <div className="anybot-agent-tools">
            <h3 className="anybot-agent-label"><Wrench className="icon" aria-hidden="true" /> Capabilities</h3>
            <ul className="flex flex-wrap gap-1.5" aria-label="Agent tools">
              {["execute_shell", "read_file", "write_file", "list_directory"].map((tool) => (
                <li key={tool} className="tag neutral"><code>{tool}</code></li>
              ))}
            </ul>
          </div>
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>{isSaved ? "Close" : "Cancel"}</button>
          <button type="submit" className="btn primary"><Check className="icon" aria-hidden="true" /> Save changes</button>
          <span role="status" className="anybot-agent-saved">{isSaved ? "Saved" : ""}</span>
        </footer>
      </form>
    </dialog>
  );
};

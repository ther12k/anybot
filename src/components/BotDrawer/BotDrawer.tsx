import React, { useState, useEffect, useRef } from "react";
import { X, Shield, Sliders, Wrench, Check } from "lucide-react";
import { BotPersona } from "../../types";

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
  const [autoApproveSafeTools, setAutoApproveSafeTools] = useState(
    bot.autoApproveSafeTools
  );
  const [isSaved, setIsSaved] = useState(false);

  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Drafts reset from the live bot whenever the drawer opens or the bot changes
  useEffect(() => {
    setName(bot.name);
    setDescription(bot.description);
    setAvatar(bot.avatar);
    setSystemPrompt(bot.systemPrompt);
    setTemperature(bot.temperature);
    setAutoApproveSafeTools(bot.autoApproveSafeTools);
  }, [bot, isOpen]);

  // Escape closes; focus moves into the drawer so keyboard users land here
  useEffect(() => {
    if (!isOpen) return;
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSave = () => {
    onUpdateBot({
      ...bot,
      name,
      description,
      avatar,
      systemPrompt,
      temperature,
      autoApproveSafeTools,
    });
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2000);
  };

  const inputCls =
    "rounded-lg bg-elevated border border-stroke text-primary focus:outline-none focus:border-strokeStrong focus-visible:ring-2 focus-visible:ring-accent select-text";

  return (
    <div
      role="dialog"
      aria-label="Configure agent"
      className="fixed inset-y-0 right-0 w-[calc(100%-1rem)] max-w-96 bg-chrome border-l border-stroke shadow-xl flex flex-col z-50"
    >
      {/* Header */}
      <div className="px-4 h-12 border-b border-stroke flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm select-none" aria-hidden="true">{bot.avatar}</span>
          <h2 className="text-sm font-semibold text-primary">Configure agent</h2>
        </div>
        <button
          ref={closeBtnRef}
          onClick={onClose}
          className="p-1.5 text-tertiary hover:text-primary rounded-lg hover:bg-hover transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Close agent configuration"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-5 text-xs select-text">
        {/* Identity */}
        <div className="space-y-1.5">
          <label
            htmlFor="bot-avatar"
            className="text-xxs font-semibold text-tertiary uppercase tracking-wide block"
          >
            Avatar
          </label>
          <div className="flex items-center gap-2">
            <input
              id="bot-avatar"
              type="text"
              value={avatar}
              onChange={(e) => setAvatar(e.target.value)}
              className={`w-11 h-9 text-center ${inputCls}`}
              placeholder="⚡"
            />
            <div className="flex-1 space-y-1">
              <label htmlFor="bot-name" className="sr-only">
                Agent name
              </label>
              <input
                id="bot-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={`w-full h-9 px-2.5 font-medium ${inputCls}`}
                placeholder="Agent name"
              />
            </div>
          </div>
          <label htmlFor="bot-description" className="sr-only">
            Description
          </label>
          <textarea
            id="bot-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className={`w-full p-2.5 text-secondary resize-none ${inputCls}`}
            placeholder="What this agent does…"
          />
        </div>

        {/* System prompt */}
        <div className="space-y-1.5">
          <label
            htmlFor="bot-instructions"
            className="text-xxs font-semibold text-tertiary uppercase tracking-wide flex items-center justify-between"
          >
            <span>Instructions</span>
            <span className="text-quaternary font-mono normal-case">
              {systemPrompt.length} chars
            </span>
          </label>
          <textarea
            id="bot-instructions"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={9}
            className={`w-full p-2.5 text-secondary font-mono text-xxs leading-[18px] resize-none ${inputCls}`}
            placeholder="System instructions for the agent…"
          />
        </div>

        {/* Temperature */}
        <div className="space-y-2 p-3 rounded-xl bg-sidebar border border-stroke">
          <div className="flex items-center justify-between">
            <label
              htmlFor="bot-temperature"
              className="flex items-center gap-1.5 font-semibold text-secondary"
            >
              <Sliders className="w-3.5 h-3.5 text-accent" aria-hidden="true" />
              <span>Temperature</span>
            </label>
            <span className="font-mono text-accent font-semibold">
              {temperature.toFixed(2)}
            </span>
          </div>
          <input
            id="bot-temperature"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={temperature}
            onChange={(e) => setTemperature(parseFloat(e.target.value))}
            className="w-full accent-[#1c1c1c] cursor-pointer"
          />
          <div className="flex justify-between text-xxs text-quaternary">
            <span>Precise</span>
            <span>Balanced</span>
            <span>Creative</span>
          </div>
        </div>

        {/* Auto-approve */}
        <div className="p-3 rounded-xl bg-sidebar border border-stroke flex items-center justify-between gap-3">
          <div>
            <div
              id="bot-auto-approve-label"
              className="flex items-center gap-1.5 font-semibold text-secondary mb-0.5"
            >
              <Shield className="w-3.5 h-3.5 text-success" aria-hidden="true" />
              <span>Auto-run safe commands</span>
            </div>
            <p className="text-xxs text-quaternary leading-relaxed">
              Read-only commands (ls, cat, git status) run without asking — this
              switch AND the global one in Settings must both be on. Changes
              always ask first.
            </p>
          </div>
          <button
            onClick={() => setAutoApproveSafeTools(!autoApproveSafeTools)}
            role="switch"
            aria-checked={autoApproveSafeTools}
            aria-labelledby="bot-auto-approve-label"
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

        {/* Capabilities */}
        <div className="p-3 rounded-xl bg-sidebar border border-stroke space-y-2">
          <div className="flex items-center gap-1.5 font-semibold text-secondary">
            <Wrench className="w-3.5 h-3.5 text-tertiary" aria-hidden="true" />
            <span>Capabilities</span>
          </div>
          <ul className="grid grid-cols-2 gap-1.5 text-xxs text-secondary font-mono list-none">
            {["execute_shell", "read_file", "write_file", "list_directory"].map(
              (tool) => (
                <li
                  key={tool}
                  className="px-2 py-1.5 rounded-lg bg-elevated border border-stroke flex items-center gap-1.5"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" aria-hidden="true" />
                  {tool}
                </li>
              )
            )}
          </ul>
        </div>
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-stroke bg-sidebar">
        <button
          onClick={handleSave}
          className="w-full py-2 rounded-xl bg-bubbleUser hover:bg-[#333] text-white font-medium text-xs flex items-center justify-center gap-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {isSaved ? (
            <>
              <Check className="w-4 h-4" aria-hidden="true" />
              <span>Saved</span>
            </>
          ) : (
            <span>Save changes</span>
          )}
        </button>
      </div>
    </div>
  );
};

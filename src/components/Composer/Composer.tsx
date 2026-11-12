import React, { useState, useRef, useEffect } from "react";
import { ArrowUp, Square, ChevronDown, Plus, AtSign } from "lucide-react";
import { AIModel } from "../../types";
import { AVAILABLE_MODELS } from "../../services/ai/models";

interface ComposerProps {
  onSendMessage: (content: string) => void;
  onStop: () => void;
  isGenerating: boolean;
  selectedModel: AIModel;
  onSelectModel: (model: AIModel) => void;
}

export const Composer: React.FC<ComposerProps> = ({
  onSendMessage,
  onStop,
  isGenerating,
  selectedModel,
  onSelectModel,
}) => {
  const [input, setInput] = useState("");
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(
        textareaRef.current.scrollHeight,
        180
      )}px`;
    }
  }, [input]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsModelDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    if (!input.trim() || isGenerating) return;
    onSendMessage(input.trim());
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  return (
    <div className="px-6 pb-4 pt-1 bg-chrome">
      <div className="max-w-[min(760px,100%)] mx-auto">
        {/* Model selector row — above composer, Grok style */}
        <div className="relative flex items-center justify-between mb-1.5 px-1" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}
            className="flex items-center gap-1 text-xs font-medium text-secondary hover:text-primary transition-colors py-1"
          >
            <span className="truncate max-w-[220px]">{selectedModel.name}</span>
            <ChevronDown
              className={`w-3 h-3 text-quaternary transition-transform ${
                isModelDropdownOpen ? "rotate-180" : ""
              }`}
            />
          </button>

          <span className="text-xxs text-quaternary">
            AnyBot can run commands on this computer
          </span>

          {isModelDropdownOpen && (
            <div className="absolute bottom-full mb-1.5 left-0 w-72 max-h-80 overflow-y-auto rounded-xl border border-stroke bg-elevated shadow-lg p-1 z-50">
              <div className="px-2 py-1.5 text-xxs font-semibold text-quaternary uppercase tracking-wide">
                Select model
              </div>
              {AVAILABLE_MODELS.map((model) => (
                <button
                  key={model.id}
                  onClick={() => {
                    onSelectModel(model);
                    setIsModelDropdownOpen(false);
                  }}
                  className={`w-full px-2.5 py-1.5 rounded-lg text-left text-xs flex items-center justify-between transition-colors ${
                    selectedModel.id === model.id
                      ? "bg-accent-soft text-primary"
                      : "hover:bg-hover text-secondary"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="font-medium text-primary truncate">
                      {model.name}
                    </div>
                    <div className="text-xxs text-quaternary uppercase">
                      {model.provider}
                    </div>
                  </div>
                  {model.supportsThinking && (
                    <span className="text-xxs px-1.5 py-px rounded bg-hover text-tertiary shrink-0">
                      thinking
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Composer box — white elevated, subtle border, rounded 24px */}
        <div className="rounded-3xl border border-stroke bg-elevated focus-within:border-strokeStrong transition-colors shadow-[0_1px_3px_rgba(28,28,28,0.05)]">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Anything"
            rows={1}
            className="w-full px-4 pt-3.5 pb-1 bg-transparent text-base text-primary placeholder-quaternary focus:outline-none resize-none leading-[22px] select-text"
          />

          <div className="flex items-center justify-between px-2.5 pb-2.5 pt-1">
            {/* Left utilities — disabled until implemented */}
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                disabled
                className="p-1.5 rounded-lg text-quaternary cursor-not-allowed disabled:opacity-50 transition-colors"
                title="Attach file (coming soon)"
                aria-label="Attach file (coming soon)"
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                disabled
                className="p-1.5 rounded-lg text-quaternary cursor-not-allowed disabled:opacity-50 transition-colors"
                title="Mention (coming soon)"
                aria-label="Mention (coming soon)"
              >
                <AtSign className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            {/* Send / Stop — black circular button, Grok style */}
            <div className="flex items-center gap-2">
              {isGenerating ? (
                <button
                  type="button"
                  onClick={onStop}
                  className="w-8 h-8 rounded-full bg-bubbleUser hover:bg-[#333] text-white transition-colors flex items-center justify-center"
                  title="Stop generating"
                >
                  <Square className="w-3 h-3 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!input.trim()}
                  className="w-8 h-8 rounded-full bg-bubbleUser text-white transition-all flex items-center justify-center disabled:bg-hover disabled:text-quaternary hover:bg-[#333] enabled:shadow-sm"
                  title="Send (Enter)"
                >
                  <ArrowUp className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>

        <p className="text-center text-xxs text-quaternary mt-1.5 select-none">
          Enter to send · Shift+Enter for new line
        </p>
      </div>
    </div>
  );
};

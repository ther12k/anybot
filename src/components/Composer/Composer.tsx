import React, { useState, useRef, useEffect, useMemo } from "react";
import { ArrowUp, Square, ChevronDown, Plus, AtSign } from "lucide-react";
import { AIModel, BotPersona } from "../../types";
import { AVAILABLE_MODELS } from "../../services/ai/models";

interface ComposerProps {
  onSendMessage: (content: string) => void;
  onStop: () => void;
  isGenerating: boolean;
  /** True after Stop was clicked but before the run has settled. */
  isStopping?: boolean;
  selectedModel: AIModel;
  onSelectModel: (model: AIModel) => void;
  /** Team Room members — present enables @mention autocomplete. */
  mentionCandidates?: BotPersona[];
}

export const Composer: React.FC<ComposerProps> = ({
  onSendMessage,
  onStop,
  isGenerating,
  isStopping = false,
  selectedModel,
  onSelectModel,
  mentionCandidates,
}) => {
  const [input, setInput] = useState("");
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  /** Partial token being typed after '@' (null = popup closed). */
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const mentionMatches = useMemo(() => {
    if (mentionQuery === null || !mentionCandidates) return [];
    const q = mentionQuery.toLowerCase();
    return mentionCandidates.filter(
      (b) =>
        b.slug.toLowerCase().includes(q) ||
        b.name.toLowerCase().includes(q)
    );
  }, [mentionQuery, mentionCandidates]);

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
    // Mention popup navigation takes precedence while it is open.
    if (mentionQuery !== null && mentionMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex(
          (i) => (i - 1 + mentionMatches.length) % mentionMatches.length
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyMention(mentionMatches[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  /** Replace the partial "@tok" at the caret with "@slug " (slugs are
   *  unique, so routing is unambiguous). */
  const applyMention = (bot: BotPersona) => {
    const el = textareaRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? input.length;
    const before = input.slice(0, caret);
    const after = input.slice(caret);
    const m = before.match(/@[\w-]*$/);
    const tokenStart = m ? caret - m[0].length : caret;
    const next =
      input.slice(0, tokenStart) + `@${bot.slug} ` + after.replace(/^\s?/, "");
    setInput(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      const pos = tokenStart + bot.slug.length + 2;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    // Track the '@token' being typed at the caret (word chars only).
    if (mentionCandidates) {
      const caret = e.target.selectionStart ?? value.length;
      const m = value.slice(0, caret).match(/@([\w-]*)$/);
      if (m) {
        setMentionQuery(m[1]);
        setMentionIndex(0);
      } else {
        setMentionQuery(null);
      }
    }
  };

  const insertAt = () => {
    const el = textareaRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? input.length;
    const next = input.slice(0, caret) + "@" + input.slice(caret);
    setInput(next);
    setMentionQuery("");
    setMentionIndex(0);
    requestAnimationFrame(() => {
      const pos = caret + 1;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const handleSend = () => {
    if (!input.trim() || isGenerating) return;
    onSendMessage(input.trim());
    setInput("");
    setMentionQuery(null);
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
            <div className="absolute bottom-full mb-1.5 left-0 w-80 max-h-96 overflow-y-auto rounded-xl border border-stroke bg-elevated shadow-xl p-1 z-50">
              <div className="px-2 py-1 text-xxs font-semibold text-quaternary uppercase tracking-wide">
                Bring-Your-Own-Plan (BYOP / ACP)
              </div>
              {AVAILABLE_MODELS.filter((m) => m.isByop).map((model) => (
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
                  <div className="min-w-0 pr-2">
                    <div className="font-medium text-primary truncate">
                      {model.name}
                    </div>
                    <div className="text-xxs text-quaternary">
                      Subscription · No API fee
                    </div>
                  </div>
                  <span className="text-xxs px-1.5 py-px rounded bg-accent/10 text-accent font-medium shrink-0">
                    BYOP
                  </span>
                </button>
              ))}

              <div className="px-2 pt-2.5 pb-1 text-xxs font-semibold text-quaternary uppercase tracking-wide border-t border-stroke mt-1">
                API Keys (BYOK) &amp; Local
              </div>
              {AVAILABLE_MODELS.filter((m) => !m.isByop).map((model) => (
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
                  <div className="flex items-center gap-1 shrink-0">
                    {model.supportsThinking && (
                      <span className="text-xxs px-1.5 py-px rounded bg-hover text-tertiary">
                        thinking
                      </span>
                    )}
                    {!model.supportsTools && (
                      <span
                        className="text-xxs px-1.5 py-px rounded bg-hover text-tertiary"
                        title="This model cannot use shell/file tools — file and command tasks are disabled"
                      >
                        chat-only
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Composer box — white elevated, subtle border, rounded 24px */}
        <div className="relative rounded-3xl border border-stroke bg-elevated focus-within:border-strokeStrong transition-colors shadow-[0_1px_3px_rgba(28,28,28,0.05)]">
          {/* @mention autocomplete — Team Rooms */}
          {mentionQuery !== null && mentionMatches.length > 0 && (
            <div
              className="absolute bottom-full mb-1.5 left-3 w-64 max-h-52 overflow-y-auto rounded-xl border border-stroke bg-elevated shadow-lg p-1 z-50"
              role="listbox"
              aria-label="Mention an agent"
            >
              {mentionMatches.map((b, i) => (
                <button
                  key={b.id}
                  type="button"
                  role="option"
                  aria-selected={i === mentionIndex}
                  onMouseEnter={() => setMentionIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep textarea focus
                    applyMention(b);
                  }}
                  className={`w-full px-2.5 py-1.5 rounded-lg text-left text-xs flex items-center gap-2 transition-colors ${
                    i === mentionIndex ? "bg-accent-soft" : "hover:bg-hover"
                  }`}
                >
                  <span
                    className="w-5 h-5 rounded-lg bg-hover flex items-center justify-center shrink-0 select-none"
                    aria-hidden="true"
                  >
                    {b.avatar}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium text-primary truncate">
                      {b.name}
                    </span>
                    <span className="block text-xxs text-quaternary truncate font-mono">
                      @{b.slug}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={mentionCandidates ? "Message the room — @ to mention" : "Ask Anything"}
            rows={1}
            className="w-full px-4 pt-3.5 pb-1 bg-transparent text-base text-primary placeholder-quaternary focus:outline-none resize-none leading-[22px] select-text"
          />

          <div className="flex items-center justify-between px-2.5 pb-2.5 pt-1">
            {/* Left utilities */}
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
                onClick={insertAt}
                disabled={!mentionCandidates}
                className={`p-1.5 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  mentionCandidates
                    ? "text-tertiary hover:text-primary hover:bg-hover"
                    : "text-quaternary cursor-not-allowed disabled:opacity-50"
                }`}
                title={
                  mentionCandidates
                    ? "Mention an agent in this room"
                    : "Mention — available in team rooms"
                }
                aria-label={
                  mentionCandidates
                    ? "Mention an agent in this room"
                    : "Mention — available in team rooms"
                }
              >
                <AtSign className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            {/* Send / Stop — ink circular button; honest Stopping state */}
            <div className="flex items-center gap-2">
              {isStopping ? (
                <span
                  className="w-8 h-8 rounded-full bg-bubbleUser text-white flex items-center justify-center opacity-70"
                  role="status"
                  title="Stopping — waiting for the running task to settle"
                >
                  <Square className="w-3 h-3 fill-current" />
                </span>
              ) : isGenerating ? (
                <button
                  type="button"
                  onClick={onStop}
                  className="w-8 h-8 rounded-full bg-bubbleUser hover:bg-[#3d3733] text-white transition-colors flex items-center justify-center"
                  title="Stop generating"
                >
                  <Square className="w-3 h-3 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!input.trim()}
                  className="w-8 h-8 rounded-full bg-bubbleUser text-white transition-all flex items-center justify-center disabled:bg-hover disabled:text-quaternary hover:bg-[#3d3733] enabled:shadow-sm"
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

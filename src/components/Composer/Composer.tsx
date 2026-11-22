import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowUp, AtSign, ChevronDown, LockKeyhole, Plus, ShieldCheck, Sparkles, Square, Wrench } from "lucide-react";
import { AIModel, BotPersona } from "../../types";
import { AVAILABLE_MODELS, isCliModel } from "../../services/ai/models";
import "./composer.css";

interface ComposerProps {
  onSendMessage: (content: string) => void;
  onStop: () => void;
  isGenerating: boolean;
  /** True after Stop was clicked but before the run has settled. */
  isStopping?: boolean;
  isAwaitingApproval?: boolean;
  botName?: string;
  selectedModel: AIModel;
  onSelectModel: (model: AIModel) => void;
  /** Team Room members — present enables @mention autocomplete. */
  mentionCandidates?: BotPersona[];
}

const modelGroups = [
  { label: "Local CLI / ACP", models: AVAILABLE_MODELS.filter(isCliModel) },
  { label: "Provider APIs & local models", models: AVAILABLE_MODELS.filter((model) => !isCliModel(model)) },
];
const mentionPattern = /(?:^|[^\w@-])@([\w-]*)$/;

export const Composer: React.FC<ComposerProps> = ({
  onSendMessage,
  onStop,
  isGenerating,
  isStopping = false,
  isAwaitingApproval = false,
  botName,
  selectedModel,
  onSelectModel,
  mentionCandidates,
}) => {
  const [input, setInput] = useState("");
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const mentionId = useId();
  const modelId = useId();
  const guidanceId = useId();
  const busy = isGenerating || isStopping || isAwaitingApproval;
  const mentionMatches = useMemo(() => {
    if (mentionQuery === null || !mentionCandidates) return [];
    const query = mentionQuery.toLowerCase();
    return mentionCandidates.filter((bot) =>
      bot.slug.toLowerCase().includes(query) || bot.name.toLowerCase().includes(query)
    );
  }, [mentionQuery, mentionCandidates]);
  const selectedMentionIndex = Math.min(mentionIndex, mentionMatches.length - 1);
  const showMentions = !busy && Boolean(mentionCandidates) && mentionQuery !== null;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [input]);

  useEffect(() => {
    if (busy) {
      setIsModelDropdownOpen(false);
      setMentionQuery(null);
    }
  }, [busy]);

  useEffect(() => {
    if (!isModelDropdownOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!dropdownRef.current?.contains(event.target as Node)) {
        setIsModelDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isModelDropdownOpen]);

  const focusInput = (position: number) => {
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(position, position);
    });
  };

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const { value, selectionStart } = event.currentTarget;
    setInput(value);
    if (mentionCandidates) {
      setMentionQuery(value.slice(0, selectionStart).match(mentionPattern)?.[1] ?? null);
      setMentionIndex(0);
    }
  };

  const applyMention = (bot: BotPersona) => {
    const textarea = textareaRef.current;
    if (!textarea || busy) return;
    const caret = textarea.selectionStart;
    const partial = input.slice(0, caret).match(mentionPattern)?.[1];
    if (partial === undefined) return;
    const tokenStart = caret - partial.length - 1;
    const tail = input.slice(caret).replace(/^[\w-]*[ \t]?/, "");
    const mention = `@${bot.slug} `;
    setInput(input.slice(0, tokenStart) + mention + tail);
    setMentionQuery(null);
    focusInput(tokenStart + mention.length);
  };

  const insertAt = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const before = input.slice(0, textarea.selectionStart);
    const existing = before.match(mentionPattern);
    const token = existing ? "" : before && !/\s$/.test(before) ? " @" : "@";
    setInput(before + token + input.slice(textarea.selectionEnd));
    setMentionQuery(existing?.[1] ?? "");
    setMentionIndex(0);
    focusInput(before.length + token.length);
  };

  const handleSend = () => {
    const content = input.trim();
    if (!content || busy) return;
    onSendMessage(content);
    setInput("");
    setMentionQuery(null);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (showMentions) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMentionQuery(null);
        return;
      }
      if (selectedMentionIndex >= 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setMentionIndex((selectedMentionIndex + delta + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (selectedMentionIndex >= 0 && !event.shiftKey && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        applyMention(mentionMatches[selectedMentionIndex]);
        return;
      }
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) setMentionQuery(null);
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  const messageLabel = mentionCandidates ? "Message the room" : botName ? `Message ${botName}` : "Message your agent";
  const statusText = isStopping ? "Stopping… waiting for the run to settle" : isAwaitingApproval ? "Waiting for your review" : "Working on your request…";
  const cli = isCliModel(selectedModel);
  const toolsLabel = cli ? "Tools: CLI-managed" : selectedModel.supportsTools ? "Tools: Available" : "Tools: Off";

  return (
    <div className="composer-wrap">
      {busy && (
        <div className="run-bar">
          {isAwaitingApproval && !isStopping ? <LockKeyhole className="icon sm" aria-hidden="true" /> : <span className="spinner" aria-hidden="true" />}
          <span role="status">{statusText}</span>
          {!isStopping && <button type="button" className="text-link" onClick={onStop}>Stop run</button>}
        </div>
      )}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); handleSend(); }}>
        {showMentions && (
          <div className="mention-menu">
            <div className="modal-label">Room agents</div>
            {mentionMatches.length > 0 ? (
              <div id={mentionId} role="listbox" aria-label="Mention an agent">
                {mentionMatches.map((bot, index) => (
                  <button
                    key={bot.id}
                    id={`${mentionId}-${index}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === selectedMentionIndex}
                    className="mention-option"
                    onMouseEnter={() => setMentionIndex(index)}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => applyMention(bot)}
                  >
                    <span className="avatar" aria-hidden="true">{bot.avatar || <Sparkles className="icon" />}</span>
                    <strong className="min-w-0 break-words">{bot.name}</strong>
                    <small className="min-w-0 break-words">@{bot.slug}</small>
                  </button>
                ))}
              </div>
            ) : <p className="small muted px-2 py-1" role="status">No matching agents in this room.</p>}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={() => setMentionQuery(null)}
          onClick={() => setMentionQuery(null)}
          placeholder={mentionCandidates ? "Message the room, or @mention an agent…" : `${messageLabel}…`}
          aria-label={messageLabel}
          aria-describedby={guidanceId}
          aria-autocomplete={mentionCandidates ? "list" : undefined}
          aria-controls={showMentions && selectedMentionIndex >= 0 ? mentionId : undefined}
          aria-activedescendant={showMentions && selectedMentionIndex >= 0 ? `${mentionId}-${selectedMentionIndex}` : undefined}
          rows={2}
          disabled={busy}
          className="select-text"
        />
        <div className="composer-toolbar">
          <button type="button" className="icon-btn" disabled aria-label="File attachment unavailable" title="File attachment unavailable">
            <Plus className="icon" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn"
            disabled={busy || !mentionCandidates}
            onClick={insertAt}
            aria-label="Mention a room agent"
            title={mentionCandidates ? "Mention a room agent" : "Mentions are available in team rooms"}
          >
            <AtSign className="icon" aria-hidden="true" />
          </button>
          <span className="tools-toggle" title={toolsLabel}>
            <Wrench className="icon sm" aria-hidden="true" />{toolsLabel}
          </span>
          <div
            className="composer-model-wrap"
            ref={dropdownRef}
            onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setIsModelDropdownOpen(false); }}
            onKeyDown={(event) => {
              if (isModelDropdownOpen && event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setIsModelDropdownOpen(false);
                modelButtonRef.current?.focus();
              }
            }}
          >
            <button
              ref={modelButtonRef}
              type="button"
              className="model-selector"
              aria-label={`Choose model: ${selectedModel.name}`}
              aria-expanded={isModelDropdownOpen}
              aria-controls={isModelDropdownOpen ? modelId : undefined}
              disabled={busy}
              onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}
            >
              <Sparkles className="icon provider-flower shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{selectedModel.name}</span>
              <ChevronDown className="icon shrink-0" aria-hidden="true" />
            </button>
            {isModelDropdownOpen && (
              <div className="option-list composer-model-list" id={modelId} role="group" aria-label="Choose model">
                {modelGroups.map(({ label, models }) => (
                  <div key={label}>
                    <div className="modal-label">{label}</div>
                    {models.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        className={`option-item${selectedModel.id === model.id ? " selected" : ""}`}
                        aria-pressed={selectedModel.id === model.id}
                        onClick={() => {
                          onSelectModel(model);
                          setIsModelDropdownOpen(false);
                          modelButtonRef.current?.focus();
                        }}
                      >
                        <div className="grow min-w-0 break-words">
                          <strong>{model.name}</strong>
                          <small>{isCliModel(model) ? "Local CLI" : `${model.provider} · ${model.supportsTools ? "Tools supported" : "Chat only"}`}</small>
                        </div>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
          {busy ? (
            <button type="button" className="send-btn stop" onClick={onStop} disabled={isStopping} aria-label={isStopping ? "Stopping" : "Stop run"} title={isStopping ? "Waiting for the run to settle" : "Stop run"}>
              {isStopping ? <span className="spinner" aria-hidden="true" /> : <Square className="icon" aria-hidden="true" />}
            </button>
          ) : (
            <button type="submit" className="send-btn" disabled={!input.trim()} aria-label="Send message" title="Send message (Enter)">
              <ArrowUp className="icon" aria-hidden="true" />
            </button>
          )}
        </div>
      </form>
      <p className="composer-disclaimer" id={guidanceId}>
        <ShieldCheck className="icon" aria-hidden="true" />
        {cli ? "Local tools follow the selected CLI’s permissions." : "Enter to send · Shift+Enter for a new line"}
      </p>
    </div>
  );
};

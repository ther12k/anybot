import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, Check, Copy, GitBranch } from "lucide-react";
import { TranscriptEntry, BotPersona } from "../../types";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCard } from "./ToolCard";
import "./chat.css";

interface MessageItemProps {
  entry: TranscriptEntry;
  bot: BotPersona;
  isStreaming?: boolean;
  onFork?: () => void;
  onApproveTool?: (toolCallId: string) => void;
  onAlwaysAllowTool?: (toolCallId: string) => void;
  onRejectTool?: (toolCallId: string) => void;
  onRequestToolChanges?: (toolCallId: string, feedback: string) => void;
}

export const MessageItem: React.FC<MessageItemProps> = ({
  entry,
  bot,
  isStreaming = false,
  onFork,
  onApproveTool,
  onAlwaysAllowTool,
  onRejectTool,
  onRequestToolChanges,
}) => {
  const isUser = entry.role === "user";
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  const timestamp = new Date(entry.timestamp);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const handleCopy = async () => {
    clearTimeout(copyTimer.current);
    try {
      await navigator.clipboard.writeText(entry.content);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    copyTimer.current = setTimeout(() => setCopyState("idle"), 2000);
  };

  return (
    <article className="message">
      <span className={`avatar${isUser ? " user" : ""}`} aria-hidden="true">
        {isUser ? "YO" : bot.avatar || <Bot className="icon" />}
      </span>
      <div className="message-body">
        <div className="message-byline">
          <span className="min-w-0 break-words">{isUser ? "You" : bot.name}</span>
          {Number.isFinite(timestamp.getTime()) && (
            <time dateTime={timestamp.toISOString()}>
              {timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </time>
          )}
        </div>
        {isUser ? (
          <div className="user-bubble whitespace-pre-wrap break-words select-text">
            {entry.content}
          </div>
        ) : (
          <>
            {entry.thinking && (
              <ThinkingBlock
                thinking={entry.thinking}
                isActive={entry.isThinkingActive}
                durationMs={entry.thinkingDurationMs}
              />
            )}
            {(entry.content || isStreaming) && (
              <div className="message-text transcript-prose break-words select-text">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content}</ReactMarkdown>
                {isStreaming && <span className="stream-cursor" aria-hidden="true" />}
              </div>
            )}
            {entry.toolCalls?.map((toolCall) => (
              <ToolCard
                key={toolCall.id}
                toolCall={toolCall}
                onApprove={onApproveTool}
                onAlwaysAllow={onAlwaysAllowTool}
                onReject={onRejectTool}
                onRequestChanges={onRequestToolChanges}
              />
            ))}
            {!isStreaming && (entry.content || onFork) && (
              <div className="message-actions">
                {entry.content && (
                  <button type="button" className="icon-btn" onClick={handleCopy} title="Copy response" aria-label="Copy response">
                    {copyState === "copied" ? <Check className="icon" aria-hidden="true" /> : <Copy className="icon" aria-hidden="true" />}
                  </button>
                )}
                {onFork && (
                  <button type="button" className="icon-btn" onClick={onFork} title="Continue in a new chat" aria-label="Continue in a new chat">
                    <GitBranch className="icon" aria-hidden="true" />
                  </button>
                )}
                <span role="status" className={copyState === "failed" ? "text-xs self-center" : "sr-only"}>
                  {copyState === "copied" ? "Response copied" : copyState === "failed" ? "Could not copy response" : ""}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </article>
  );
};

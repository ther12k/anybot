import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";
import { TranscriptEntry, BotPersona } from "../../types";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCard } from "./ToolCard";

interface MessageItemProps {
  entry: TranscriptEntry;
  bot: BotPersona;
  onApproveTool?: (toolCallId: string) => void;
  onAlwaysAllowTool?: (toolCallId: string) => void;
  onRejectTool?: (toolCallId: string) => void;
}

export const MessageItem: React.FC<MessageItemProps> = ({
  entry,
  bot,
  onApproveTool,
  onAlwaysAllowTool,
  onRejectTool,
}) => {
  const isUser = entry.role === "user";
  const [copied, setCopied] = React.useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(entry.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /* ── User turn: Grok-style black bubble, right-aligned, max 640px ── */
  if (isUser) {
    return (
      <div className="w-full flex justify-end px-6 py-1.5">
        <div
          className="max-w-[min(640px,100%)] rounded-bubble bg-bubbleUser px-4 py-2 text-white select-text"
          style={{ minWidth: "min(100%, 48px)" }}
        >
          <p className="text-base whitespace-pre-wrap break-words">
            {entry.content}
          </p>
        </div>
      </div>
    );
  }

  /* ── Agent turn: flat on chrome, sender row + thinking + prose + tool cards ── */
  return (
    <div className="w-full px-6 py-2 group">
      {/* Sender row — avatar + name (Grok transcript sender line) */}
      <div className="flex items-center gap-2 mb-1">
        <div className="w-5 h-5 rounded-full bg-bubbleUser flex items-center justify-center text-[10px] leading-none select-none">
          {bot.avatar || "⚡"}
        </div>
        <span className="text-xs font-semibold text-secondary">
          {bot.name}
        </span>
        <span className="text-xxs text-quaternary font-mono">
          {new Date(entry.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>

        {entry.content && (
          <button
            onClick={handleCopy}
            className="ml-auto text-quaternary hover:text-primary transition-colors p-1 rounded-md opacity-0 group-hover:opacity-100"
            title="Copy message"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-success" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        )}
      </div>

      {/* Thinking drawer */}
      {entry.thinking && (
        <ThinkingBlock
          thinking={entry.thinking}
          isActive={entry.isThinkingActive}
          durationMs={entry.thinkingDurationMs}
        />
      )}

      {/* Agent prose — flat, 14px / 22px line height */}
      {entry.content && (
        <div className="transcript-prose text-primary select-text max-w-[min(720px,100%)]">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {entry.content}
          </ReactMarkdown>
        </div>
      )}

      {/* Tool action cards */}
      {entry.toolCalls && entry.toolCalls.length > 0 && (
        <div className="mt-1.5 space-y-2 max-w-[min(720px,100%)]">
          {entry.toolCalls.map((tc) => (
            <ToolCard
              key={tc.id}
              toolCall={tc}
              onApprove={onApproveTool}
              onAlwaysAllow={onAlwaysAllowTool}
              onReject={onRejectTool}
            />
          ))}
        </div>
      )}
    </div>
  );
};

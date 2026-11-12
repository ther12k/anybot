import React, { useState } from "react";
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";

interface ThinkingBlockProps {
  thinking: string;
  isActive?: boolean;
  durationMs?: number;
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({
  thinking,
  isActive = false,
  durationMs,
}) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(isActive);

  if (!thinking) return null;

  const durationSec = durationMs ? (durationMs / 1000).toFixed(1) : null;

  return (
    <div className="mb-1.5 max-w-[min(720px,100%)]">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
          isActive
            ? "bg-hover text-secondary"
            : "text-quaternary hover:bg-hover hover:text-secondary"
        }`}
      >
        {isActive ? (
          <Sparkles className="w-3.5 h-3.5 motion-safe:animate-pulse text-accent" />
        ) : (
          <Sparkles className="w-3.5 h-3.5" />
        )}
        <span>{isActive ? "Thinking" : "Thought for"}</span>
        {durationSec && !isActive && (
          <span className="font-mono text-xxs">{durationSec}s</span>
        )}
        {isExpanded ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
      </button>

      {isExpanded && (
        <div className="mt-1.5 px-3.5 py-2.5 rounded-xl bg-bubbleAgent text-xs font-mono text-tertiary whitespace-pre-wrap leading-[18px] max-h-64 overflow-y-auto select-text border border-transparent">
          {thinking}
        </div>
      )}
    </div>
  );
};

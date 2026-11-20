import React, { useId, useState } from "react";
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
  const [isExpanded, setIsExpanded] = useState(isActive);
  const detailId = useId();

  if (!thinking) return null;

  const duration = !isActive && durationMs ? `${(durationMs / 1000).toFixed(1)}s` : null;
  const Chevron = isExpanded ? ChevronDown : ChevronRight;

  return (
    <div>
      <button
        type="button"
        className="thinking-toggle"
        aria-expanded={isExpanded}
        aria-controls={detailId}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <Sparkles className={`icon sm${isActive ? " motion-safe:animate-pulse" : ""}`} aria-hidden="true" />
        <span>{isActive ? "Provider thinking…" : "Provider thinking"}</span>
        {duration && <span className="font-mono">{duration}</span>}
        <Chevron className="icon sm" aria-hidden="true" />
      </button>
      <div id={detailId} hidden={!isExpanded} className="thinking-detail max-h-64 overflow-y-auto whitespace-pre-wrap break-words select-text">
        {thinking}
      </div>
    </div>
  );
};

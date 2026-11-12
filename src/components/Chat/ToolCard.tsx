import React, { useState } from "react";
import {
  Terminal,
  FileText,
  Folder,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  ShieldAlert,
  Play,
  X,
} from "lucide-react";
import { ToolCallItem } from "../../types";
import { DiffViewer } from "./DiffViewer";

interface ToolCardProps {
  toolCall: ToolCallItem;
  onApprove?: (toolCallId: string) => void;
  onAlwaysAllow?: (toolCallId: string) => void;
  onReject?: (toolCallId: string) => void;
}

const TOOL_META: Record<
  string,
  { label: string; icon: React.ReactNode; statusText: string }
> = {
  execute_shell: {
    label: "Running commands",
    icon: <Terminal className="w-3.5 h-3.5" />,
    statusText: "Shell",
  },
  read_file: {
    label: "Reading a file",
    icon: <FileText className="w-3.5 h-3.5" />,
    statusText: "Read",
  },
  write_file: {
    label: "Editing a file",
    icon: <FileText className="w-3.5 h-3.5" />,
    statusText: "Write",
  },
  list_directory: {
    label: "Browsing files",
    icon: <Folder className="w-3.5 h-3.5" />,
    statusText: "List",
  },
};

export const ToolCard: React.FC<ToolCardProps> = ({
  toolCall,
  onApprove,
  onAlwaysAllow,
  onReject,
}) => {
  const [isOutputExpanded, setIsOutputExpanded] = useState<boolean>(true);

  const meta = TOOL_META[toolCall.name] ?? {
    label: toolCall.name,
    icon: <Terminal className="w-3.5 h-3.5" />,
    statusText: "Tool",
  };

  const getStatusBadge = () => {
    switch (toolCall.status) {
      case "pending_approval":
        return (
          <span className="flex items-center gap-1 text-xxs font-medium text-[#9d6937]">
            <AlertTriangle className="w-3 h-3" />
            Needs approval
          </span>
        );
      case "running":
        return (
          <span className="flex items-center gap-1 text-xxs font-medium text-accent">
            <Loader2 className="w-3 h-3 motion-safe:animate-spin" />
            Running
          </span>
        );
      case "completed":
        return (
          <span className="flex items-center gap-1 text-xxs font-medium text-success">
            <CheckCircle2 className="w-3 h-3" />
            Done
          </span>
        );
      case "failed":
        return (
          <span className="flex items-center gap-1 text-xxs font-medium text-danger">
            <XCircle className="w-3 h-3" />
            Failed
          </span>
        );
      case "rejected":
        return (
          <span className="flex items-center gap-1 text-xxs font-medium text-quaternary">
            <XCircle className="w-3 h-3" />
            Rejected
          </span>
        );
    }
  };

  return (
    <div className="rounded-xl border border-stroke bg-elevated overflow-hidden shadow-[0_1px_2px_rgba(28,28,28,0.04)]">
      {/* Header — Grok action pill style */}
      <div className="px-3 py-2 flex items-center justify-between gap-2 bg-elevated">
        <div className="flex items-center gap-2 min-w-0 text-secondary">
          {meta.icon}
          <span className="text-xs font-medium truncate">{meta.label}</span>
          {toolCall.safetyTier && toolCall.safetyTier !== "Safe" && (
            <span
              className={`text-xxs px-1.5 py-px rounded font-mono ${
                toolCall.safetyTier === "Dangerous"
                  ? "bg-danger/10 text-danger"
                  : "bg-hover text-tertiary"
              }`}
            >
              {toolCall.safetyTier}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {toolCall.result?.executionTimeMs !== undefined && (
            <span className="text-xxs text-quaternary font-mono">
              {toolCall.result.executionTimeMs}ms
            </span>
          )}
          {getStatusBadge()}
        </div>
      </div>

      {/* Arguments preview */}
      <div className="px-3 py-2 bg-chrome border-t border-stroke text-xs font-mono select-text">
        {toolCall.name === "execute_shell" && (
          <div className="flex items-start gap-1.5 text-primary">
            <span className="text-secondary select-none">$</span>
            <span className="break-all">{toolCall.arguments.command}</span>
          </div>
        )}
        {(toolCall.name === "read_file" || toolCall.name === "write_file") && (
          <div className="text-tertiary">
            <span className="select-none">path: </span>
            <span className="text-primary">{toolCall.arguments.path}</span>
          </div>
        )}
        {toolCall.name === "list_directory" && (
          <div className="text-tertiary">
            <span className="select-none">dir: </span>
            <span className="text-primary">{toolCall.arguments.path}</span>
          </div>
        )}
      </div>

      {/* Approval bar — permission card. write_file shows the exact proposed
          diff above (prepared before approval) and decides Apply / Decline. */}
      {toolCall.status === "pending_approval" && (
        <div className="px-3 py-2.5 bg-hover border-t border-stroke flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-secondary min-w-0">
            <ShieldAlert className="w-4 h-4 shrink-0 text-accent" />
            {toolCall.name === "write_file" ? (
              <span className="truncate">
                {toolCall.result?.diff?.existed === false
                  ? "Creates a new file — review the proposed content."
                  : "Proposed change — review what will be written."}
              </span>
            ) : (
              <span className="truncate">
                {toolCall.safetyReason || "Allow this action?"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
            {toolCall.name === "write_file" ? (
              <>
                <button
                  onClick={() => onReject?.(toolCall.id)}
                  className="px-2.5 py-1 text-xs font-medium text-secondary hover:text-primary bg-elevated border border-stroke hover:bg-elevatedHover rounded-lg transition-colors flex items-center gap-1"
                >
                  <X className="w-3 h-3" />
                  Decline
                </button>
                <button
                  onClick={() => onApprove?.(toolCall.id)}
                  className="px-3 py-1 text-xs font-medium text-white bg-bubbleUser hover:bg-[#3d3733] rounded-lg transition-colors flex items-center gap-1.5"
                  title="Apply exactly this reviewed change"
                >
                  <Play className="w-3 h-3 fill-current" />
                  Apply change
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => onReject?.(toolCall.id)}
                  className="px-2.5 py-1 text-xs font-medium text-secondary hover:text-primary bg-elevated border border-stroke hover:bg-elevatedHover rounded-lg transition-colors flex items-center gap-1"
                >
                  <X className="w-3 h-3" />
                  Deny
                </button>
                {toolCall.name === "execute_shell" && onAlwaysAllow && (
                  <button
                    onClick={() => onAlwaysAllow(toolCall.id)}
                    className="px-2.5 py-1 text-xs font-medium text-secondary hover:text-primary bg-elevated border border-stroke hover:bg-elevatedHover rounded-lg transition-colors"
                    title="Always allow this exact command in this workspace (creates a standing grant)"
                  >
                    Always allow
                  </button>
                )}
                <button
                  onClick={() => onApprove?.(toolCall.id)}
                  className="px-3 py-1 text-xs font-medium text-white bg-bubbleUser hover:bg-[#3d3733] rounded-lg transition-colors flex items-center gap-1.5"
                >
                  <Play className="w-3 h-3 fill-current" />
                  Approve
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Proposed or applied diff for write_file */}
      {toolCall.result?.diff && (
        <DiffViewer
          before={toolCall.result.diff.before}
          after={toolCall.result.diff.after}
          path={toolCall.result.diff.path}
        />
      )}

      {/* Failure reason strip — shown even when a diff is present (e.g. a
          stale proposal that was refused instead of overwriting) */}
      {toolCall.result?.error && toolCall.status !== "pending_approval" && (
        <div className="px-3 py-2 bg-chrome border-t border-stroke text-xs text-danger flex items-start gap-1.5">
          <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="select-text">{toolCall.result.error}</span>
        </div>
      )}

      {/* Output */}
      {toolCall.result && !toolCall.result.diff && toolCall.result.output && (
        <div className="border-t border-stroke">
          <button
            onClick={() => setIsOutputExpanded(!isOutputExpanded)}
            className="w-full px-3 py-1.5 bg-chrome flex items-center justify-between text-xxs text-quaternary hover:text-secondary transition-colors"
          >
            <span>Output</span>
            {isOutputExpanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </button>
          {isOutputExpanded && (
            <pre className="px-3 py-2 bg-chrome text-xxs font-mono max-h-44 overflow-y-auto whitespace-pre-wrap select-text text-tertiary">
              {toolCall.result.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

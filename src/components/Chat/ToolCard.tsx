import React, { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  CircleX,
  FileText,
  Folder,
  LockKeyhole,
  Pencil,
  ShieldCheck,
  Terminal,
  Users,
  X,
} from "lucide-react";
import { ToolCallItem } from "../../types";
import { DiffViewer } from "./DiffViewer";

interface ToolCardProps {
  toolCall: ToolCallItem;
  onApprove?: (toolCallId: string) => void;
  onAlwaysAllow?: (toolCallId: string) => void;
  onReject?: (toolCallId: string) => void;
  onRequestChanges?: (toolCallId: string, feedback: string) => void;
}

const TOOL_META = {
  execute_shell: { label: "Run command", Icon: Terminal },
  read_file: { label: "Read file", Icon: FileText },
  write_file: { label: "Write file", Icon: FileText },
  list_directory: { label: "List files", Icon: Folder },
  delegate_task: { label: "Delegate task", Icon: Users },
};

const STATUS_META = {
  pending_approval: { label: "Needs approval", color: "amber", Icon: LockKeyhole },
  running: { label: "Running", color: "purple", Icon: null },
  completed: { label: "Done", color: "green", Icon: Check },
  failed: { label: "Failed", color: "red", Icon: CircleX },
  rejected: { label: "Rejected", color: "red", Icon: X },
};

function ToolResult({ toolCall }: { toolCall: ToolCallItem }) {
  const { result, status } = toolCall;
  return (
    <>
      {Boolean(toolCall.recoveredToolCallIds?.length) && (
        <p className="small muted">Retry succeeded. Earlier failed attempts are kept above.</p>
      )}
      {result?.error && status !== "pending_approval" && (
        <div className="state-notice error break-words">
          <CircleX className="icon shrink-0" aria-hidden="true" />
          <span className="min-w-0 select-text">{result.error}</span>
        </div>
      )}
      {result?.output && (
        <details className="tool-output">
          <summary>Output</summary>
          <pre tabIndex={0} aria-label="Tool output" className="max-h-44 overflow-auto whitespace-pre-wrap break-words select-text">
            {result.output}
          </pre>
        </details>
      )}
    </>
  );
}

export const ToolCard: React.FC<ToolCardProps> = ({
  toolCall,
  onApprove,
  onAlwaysAllow,
  onReject,
  onRequestChanges,
}) => {
  const [requestOpen, setRequestOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const requestButton = useRef<HTMLButtonElement>(null);
  const feedbackInput = useRef<HTMLTextAreaElement>(null);
  const feedbackId = useId();
  useEffect(() => {
    if (requestOpen) feedbackInput.current?.focus();
  }, [requestOpen]);
  const { id, name, status, arguments: args, result, proposalId, safetyReason, safetyTier } = toolCall;
  const { label: toolLabel, Icon: ToolIcon } = TOOL_META[name] ?? { label: name, Icon: Terminal };
  const { label: statusLabel, color, Icon: StatusIcon } = STATUS_META[status];
  const pending = status === "pending_approval";
  const file = name === "write_file";
  const shell = name === "execute_shell";
  const diff = result?.diff;
  const command = String(args.command ?? "");
  const path = String(diff?.path ?? args.path ?? "");
  const target = shell ? command : name === "delegate_task" ? String(args.bot ?? "") : path;
  const task = name === "delegate_task" ? String(args.task ?? "") : "";
  const isReview = pending || Boolean(diff) || Boolean(shell && proposalId);
  // Never offer to apply a file write when there is no reviewed snapshot.
  const canApprove = Boolean(onApprove && (!file || diff));
  const canRequest = Boolean(onRequestChanges && file && diff);
  const elapsed = result?.executionTimeMs;
  const statusText = file && diff && status === "completed" ? "Applied" : statusLabel;
  const statusMark = status === "running" ? <span className="spinner" aria-hidden="true" /> : StatusIcon && <StatusIcon className="icon" aria-hidden="true" />;

  if (!isReview) {
    return (
      <div className="tool-stack">
        <div className={`tool-row${status === "running" ? " active" : ""}`}>
          {status === "completed" ? <Check className="icon check-mark shrink-0" aria-hidden="true" /> : <ToolIcon className="icon shrink-0" aria-hidden="true" />}
          <span className="tool-name">{toolLabel}</span>
          {target && <code className="file-chip min-w-0 truncate select-text" title={target}>{target}</code>}
          {elapsed !== undefined && <span className="tool-detail shrink-0">{elapsed} ms</span>}
          <span className={`tool-end tool-status ${color}`}>{statusMark}{statusText}</span>
        </div>
        {(task || (shell && command)) && (
          <details className="tool-output">
            <summary>{shell ? "Exact command" : "Delegated task"}</summary>
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words select-text">{shell ? command : task}</pre>
          </details>
        )}
        <ToolResult toolCall={toolCall} />
      </div>
    );
  }

  const title = file ? "Proposed file change" : shell ? "Proposed command" : toolLabel;
  const reason = file
    ? diff?.existed === false
      ? "Creates a new file. Review its full contents before applying."
      : !diff ? "The proposed diff is unavailable. This change cannot be approved here." : null
    : safetyReason || "Review the exact action before allowing it to continue.";
  return (
    <section className="proposal-card" aria-label={title}>
      <div className="proposal-head">
        <ToolIcon className="icon shrink-0" aria-hidden="true" />
        <div className="grow min-w-0">
          <div className="proposal-title">{title}</div>
          <div className="proposal-subtitle break-words select-text">{file ? path : shell ? name : target}</div>
        </div>
        <span className={`tag ${color}`}>{statusMark}{statusText}</span>
      </div>
      {diff && <DiffViewer before={diff.before} after={diff.after} path={diff.path} />}
      {shell && <pre className="command-preview whitespace-pre-wrap select-text">{`$ ${command}`}</pre>}
      {shell && args.cwd && <p className="command-reason break-words select-text">Working directory: {String(args.cwd)}</p>}
      {pending && reason && <p className="command-reason break-words">{safetyTier && !file ? `${safetyTier} · ` : ""}{reason}</p>}
      <ToolResult toolCall={toolCall} />
      {pending && (
        <>
          <div className="proposal-foot">
            {canApprove && (
              <button type="button" className="btn primary" onClick={() => onApprove?.(id)}>
                <Check className="icon" aria-hidden="true" />{file ? "Approve & Apply" : "Approve once"}
              </button>
            )}
            {canRequest && (
              <button type="button" className="btn" ref={requestButton} aria-expanded={requestOpen} aria-controls={requestOpen ? feedbackId : undefined} onClick={() => setRequestOpen(!requestOpen)}>
                <Pencil className="icon" aria-hidden="true" />Request changes
              </button>
            )}
            {onReject && (
              <button type="button" className="btn danger" onClick={() => onReject(id)}>
                <X className="icon" aria-hidden="true" />Reject
              </button>
            )}
            {shell && onAlwaysAllow && (
              <button type="button" className="btn ghost" onClick={() => onAlwaysAllow(id)}>
                <LockKeyhole className="icon" aria-hidden="true" />Always allow exact command
              </button>
            )}
          </div>
          {canRequest && requestOpen && (
            <form id={feedbackId} className="review-feedback field" onSubmit={(event) => {
              event.preventDefault();
              const notes = feedback.trim();
              if (!notes) return;
              onRequestChanges?.(id, notes);
              setRequestOpen(false);
              setFeedback("");
              requestButton.current?.focus();
            }}>
              <label htmlFor={`${feedbackId}-input`}>What should be different?</label>
              <textarea
                id={`${feedbackId}-input`}
                ref={feedbackInput}
                rows={3}
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                    event.stopPropagation();
                    setRequestOpen(false);
                    requestButton.current?.focus();
                  }
                }}
                required
              />
              <div className="proposal-foot">
                <button type="submit" className="btn primary" disabled={!feedback.trim()}>Send feedback</button>
                <button type="button" className="btn ghost" onClick={() => { setRequestOpen(false); requestButton.current?.focus(); }}>Cancel</button>
              </div>
            </form>
          )}
          {(file || shell) && (
            <p className="proposal-note">
              <ShieldCheck className="icon shrink-0" aria-hidden="true" />
              {file ? "Approval applies only to this reviewed change." : "Approval applies to this exact command. Standing grants are scoped to this workspace."}
            </p>
          )}
        </>
      )}
    </section>
  );
};

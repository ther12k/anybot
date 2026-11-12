import {
  BotPersona,
  AIModel,
  TranscriptEntry,
  VaultConfig,
  ToolCallItem,
} from "../../types";
import { streamChatCompletion, ChatMessagePayload } from "../ai/streamClient";
import { TauriBridge } from "../tauri/bridge";

/**
 * Everything that belongs to ONE run: its cancellation controller, its
 * pending approvals, its tracked shell calls. Stop targets a specific run —
 * an old run's settle can never clear a newer run's state (UX-03/UX-04).
 */
interface RunContext {
  id: string;
  controller: AbortController;
  aborted: boolean;
  /** Set when a provider/turn error was rendered into the transcript. */
  hadError: boolean;
  /** Resolvers for approvals still awaiting a user decision. */
  pendingApprovals: Set<(approved: boolean) => void>;
  /** Shell executions currently running, so Stop can kill them natively. */
  runningShellCalls: Map<string, true>;
}

/** Honest terminal outcome of a whole run chain. */
export type RunOutcome = "completed" | "cancelled" | "failed";

/** The system working directory, resolved once and reused so safety checks,
 *  executions, and "Always allow" grants all agree on the same workspace. */
let cachedSystemCwd: string | null = null;
async function resolveCwd(explicit?: string): Promise<string | undefined> {
  if (explicit && explicit.trim()) return explicit;
  if (cachedSystemCwd === null) {
    try {
      cachedSystemCwd = (await TauriBridge.getSystemInfo()).cwd;
    } catch {
      cachedSystemCwd = "";
    }
  }
  return cachedSystemCwd || undefined;
}

export class AgentLoop {
  private activeRun: RunContext | null = null;

  /** True while a run has not fully settled (Stop requested but pending). */
  public isBusy(): boolean {
    return this.activeRun !== null;
  }

  /**
   * Stop the active run. Returns false when nothing is running. Pending
   * approvals resolve as "denied" and running shell commands are killed
   * natively; the run stays "busy" until its promise settles.
   */
  public abort(): boolean {
    const run = this.activeRun;
    if (!run) return false;
    run.aborted = true;
    run.controller.abort();
    for (const resolve of run.pendingApprovals) resolve(false);
    run.pendingApprovals.clear();
    for (const callId of run.runningShellCalls.keys()) {
      TauriBridge.killShellCommand(callId).catch(() => {
        // Already finished or unsupported — the bounded timeout still applies.
      });
    }
    run.runningShellCalls.clear();
    return true;
  }

  /**
   * Run one turn chain. Concurrency policy: one run at a time — a second
   * concurrent call is refused instead of silently sharing a controller.
   * Resolves with an honest terminal outcome for status display.
   */
  public async runTurn(
    threadId: string,
    transcript: TranscriptEntry[],
    bot: BotPersona,
    model: AIModel,
    vault: VaultConfig,
    onUpdateEntry: (entry: TranscriptEntry) => void,
    onAddEntry: (entry: TranscriptEntry) => void,
    onNeedsApproval: (toolCall: ToolCallItem, resolve: (approved: boolean) => void) => void
  ): Promise<RunOutcome> {
    if (this.activeRun) return "cancelled";

    const run: RunContext = {
      id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      controller: new AbortController(),
      aborted: false,
      hadError: false,
      pendingApprovals: new Set(),
      runningShellCalls: new Map(),
    };
    this.activeRun = run;
    try {
      await this.executeTurn(
        threadId, transcript, bot, model, vault,
        onUpdateEntry, onAddEntry, onNeedsApproval, run
      );
    } finally {
      // Identity check: only the owning run clears itself. A stale settle
      // can no longer detach a newer run's controller or approvals.
      if (this.activeRun === run) this.activeRun = null;
    }
    return run.aborted ? "cancelled" : run.hadError ? "failed" : "completed";
  }

  private async executeTurn(
    threadId: string,
    transcript: TranscriptEntry[],
    bot: BotPersona,
    model: AIModel,
    vault: VaultConfig,
    onUpdateEntry: (entry: TranscriptEntry) => void,
    onAddEntry: (entry: TranscriptEntry) => void,
    onNeedsApproval: (toolCall: ToolCallItem, resolve: (approved: boolean) => void) => void,
    run: RunContext
  ): Promise<void> {
    const signal = run.controller.signal;

    // Prepare message history for the model
    const messagesPayload: ChatMessagePayload[] = [];
    for (const entry of transcript) {
      if (entry.role === "user") {
        messagesPayload.push({ role: "user", content: entry.content });
      } else if (entry.role === "assistant") {
        const toolCallsPayload = entry.toolCalls?.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));

        messagesPayload.push({
          role: "assistant",
          content: entry.content,
          tool_calls: toolCallsPayload && toolCallsPayload.length > 0 ? toolCallsPayload : undefined,
        });

        if (entry.toolCalls) {
          for (const tc of entry.toolCalls) {
            messagesPayload.push({
              role: "tool",
              tool_call_id: tc.id,
              name: tc.name,
              content: tc.result?.output || tc.result?.error || "Execution completed.",
            });
          }
        }
      }
    }

    const assistantEntryId = `asst_${Date.now()}`;
    const startTime = Date.now();
    let currentContent = "";
    let currentThinking = "";
    const toolCalls: ToolCallItem[] = [];

    const assistantEntry: TranscriptEntry = {
      id: assistantEntryId,
      threadId,
      role: "assistant",
      content: "",
      thinking: "",
      isThinkingActive: false,
      timestamp: startTime,
      toolCalls: [],
    };

    onAddEntry(assistantEntry);

    try {
      await streamChatCompletion(
        model,
        vault,
        messagesPayload,
        bot.systemPrompt,
        {
          onThinkingDelta: (delta) => {
            currentThinking += delta;
            onUpdateEntry({
              ...assistantEntry,
              thinking: currentThinking,
              isThinkingActive: true,
              thinkingDurationMs: Date.now() - startTime,
            });
          },
          onContentDelta: (delta) => {
            currentContent += delta;
            onUpdateEntry({
              ...assistantEntry,
              content: currentContent,
              thinking: currentThinking,
              isThinkingActive: false,
              thinkingDurationMs: Date.now() - startTime,
            });
          },
          onToolCall: (toolCall) => {
            toolCalls.push(toolCall);
            onUpdateEntry({
              ...assistantEntry,
              content: currentContent,
              thinking: currentThinking,
              isThinkingActive: false,
              toolCalls: [...toolCalls],
            });
          },
        },
        signal,
        // The persona's temperature affects the request (where supported).
        bot.temperature
      );

      if (run.aborted || signal.aborted) return;

      onUpdateEntry({
        ...assistantEntry,
        content: currentContent,
        thinking: currentThinking,
        isThinkingActive: false,
        thinkingDurationMs: Date.now() - startTime,
        toolCalls: [...toolCalls],
      });

      // Execute any tool calls the model emitted
      if (toolCalls.length > 0) {
        for (let i = 0; i < toolCalls.length; i++) {
          if (run.aborted || signal.aborted) return;
          const tc = toolCalls[i];
          await this.executeToolWithSafety(
            tc,
            bot,
            vault,
            run,
            (updatedTc) => {
              toolCalls[i] = updatedTc;
              // Preserve what the model already streamed — tool status
              // changes must never erase the assistant's prose.
              onUpdateEntry({
                ...assistantEntry,
                content: currentContent,
                thinking: currentThinking,
                isThinkingActive: false,
                toolCalls: [...toolCalls],
              });
            },
            onNeedsApproval
          );
        }

        if (run.aborted || signal.aborted) return;

        // Continue the turn with tool results
        const updatedTranscript = [
          ...transcript,
          {
            ...assistantEntry,
            content: currentContent,
            toolCalls: [...toolCalls],
          },
        ];

        await this.executeTurn(
          threadId,
          updatedTranscript,
          bot,
          model,
          vault,
          onUpdateEntry,
          onAddEntry,
          onNeedsApproval,
          run
        );
      }
    } catch (err: any) {
      if (run.aborted || signal.aborted) return;
      run.hadError = true;
      // A response that never completed must not leave tool calls armed:
      // reject anything still pending so it can never execute later.
      for (const tc of toolCalls) {
        if (tc.status === "pending_approval") {
          tc.status = "rejected";
          tc.result = {
            error:
              "Not executed — the response was interrupted before the model finished.",
            ...(tc.result?.diff ? { diff: tc.result.diff } : {}),
          };
        }
      }
      // streamClient rethrows provider failures with recovery text in the message
      onUpdateEntry({
        ...assistantEntry,
        content:
          currentContent +
          (currentContent ? "\n\n" : "") +
          `**Error:** ${err.message}`,
        isThinkingActive: false,
        thinkingDurationMs: Date.now() - startTime,
        toolCalls: [...toolCalls],
      });
    }
  }

  private async executeToolWithSafety(
    toolCall: ToolCallItem,
    bot: BotPersona,
    vault: VaultConfig,
    run: RunContext,
    onUpdate: (tc: ToolCallItem) => void,
    onNeedsApproval: (toolCall: ToolCallItem, resolve: (approved: boolean) => void) => void
  ): Promise<void> {
    /** Mark the tool cancelled — used after every awaited preflight, so a
     *  Stop that lands mid-check never lets the action proceed. */
    const cancelTool = () => {
      toolCall.status = "rejected";
      toolCall.result = {
        error: "Cancelled by user (Stop). Nothing was executed.",
        ...(toolCall.result?.diff ? { diff: toolCall.result.diff } : {}),
      };
      onUpdate(toolCall);
    };

    // 1. Safety evaluation — decision provenance feeds the audit log.
    // Effective auto-run = agent toggle AND global vault toggle (both must
    // allow it; a restrictive setting wins).
    let requiresApproval = false;
    let safetyReason = "Read-only action";
    let safetyTier: import("../../types").CommandSafetyTier = "Safe";
    let decision = "auto_safe";

    const autoRunAllowed =
      vault.autoApproveSafeTools !== false && bot.autoApproveSafeTools !== false;

    if (toolCall.name === "execute_shell") {
      // Same cwd for the safety check AND the execution, so a workspace-
      // scoped standing grant matches both times.
      const cwd = await resolveCwd(toolCall.arguments.cwd);
      const safety = await TauriBridge.checkShellSafety(toolCall.arguments.command || "", cwd);
      if (run.aborted) return cancelTool();
      toolCall.arguments.cwd = cwd;
      safetyTier = safety.tier;
      safetyReason = safety.reason;
      if (safety.standing_grant) {
        // Exact match on a prior "Always allow" (scoped to this workspace);
        // deny rules ran first in Rust.
        requiresApproval = false;
        decision = "standing_grant";
      } else {
        requiresApproval = safety.requires_confirmation || !autoRunAllowed;
        decision = "auto_safe";
      }
    } else if (toolCall.name === "write_file") {
      safetyTier = "Mutative";
      safetyReason = "Modifies filesystem content";
      // Auto-approve covers read-only commands; writes always ask.
      requiresApproval = true;
    }

    toolCall.safetyTier = safetyTier;
    toolCall.safetyReason = safetyReason;

    if (requiresApproval) {
      // write_file: prepare the PROPOSAL first — the reviewer sees the exact
      // diff before any approval control appears (UX-07). Read failures are
      // distinguished: ONLY a real missing file enters the "new file" path;
      // binary/permission/IO errors refuse the proposal instead of guessing.
      if (toolCall.name === "write_file") {
        let beforeContent = "";
        let existed: boolean | "unknown" = false;
        try {
          const prev = await TauriBridge.readFileContent(toolCall.arguments.path);
          beforeContent = prev.content;
          existed = true;
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          if (msg.startsWith("NOT_FOUND:")) {
            existed = false; // genuinely a new file
            beforeContent = "";
          } else {
            existed = "unknown";
          }
        }
        if (existed === "unknown") {
          toolCall.status = "failed";
          toolCall.result = {
            error:
              "Cannot read the current file (it may be binary, unreadable, or locked). Refusing to propose a change without knowing what would be replaced — try reading it first or choose a different target.",
          };
          onUpdate(toolCall);
          return;
        }
        if (run.aborted) return cancelTool();
        toolCall.result = {
          diff: {
            before: beforeContent,
            after: toolCall.arguments.content ?? "",
            path: toolCall.arguments.path ?? "",
            existed,
          },
        };
      }

      // Stop during a preflight must not register a fresh approval nothing
      // will ever resolve.
      if (run.aborted) return cancelTool();

      toolCall.status = "pending_approval";
      onUpdate(toolCall);

      // The wrapped resolver also unregisters itself from the run's pending
      // approvals, so abort() only cancels approvals still awaiting a decision.
      const approved = await new Promise<boolean>((resolve) => {
        const wrapped = (v: boolean) => {
          run.pendingApprovals.delete(wrapped);
          resolve(v);
        };
        run.pendingApprovals.add(wrapped);
        onNeedsApproval(toolCall, wrapped);
      });

      if (!approved) {
        toolCall.status = "rejected";
        toolCall.result = {
          error: run.aborted
            ? "Cancelled by user (Stop). Nothing was written."
            : "Change declined by user. Nothing was written.",
          // Keep the proposal visible for reference, marked declined.
          diff: toolCall.result?.diff,
        };
        onUpdate(toolCall);
        // Rejections never reach the execution layer; audit them here.
        TauriBridge.auditEvent({
          tool: toolCall.name,
          decision: "rejected",
          outcome: "rejected",
          command: toolCall.arguments.command ?? null,
          path: toolCall.arguments.path ?? null,
        }).catch(() => {});
        return;
      }
      decision = "approved";
    }

    if (run.aborted) {
      toolCall.status = "rejected";
      toolCall.result = { error: "Cancelled by user (Stop)." };
      onUpdate(toolCall);
      return;
    }

    // 2. Execution
    toolCall.status = "running";
    onUpdate(toolCall);

    try {
      if (toolCall.name === "execute_shell") {
        run.runningShellCalls.set(toolCall.id, true);
        let res;
        try {
          res = await TauriBridge.executeShellCommand(
            toolCall.arguments.command,
            toolCall.arguments.cwd,
            60,
            toolCall.id,
            decision
          );
        } finally {
          run.runningShellCalls.delete(toolCall.id);
        }
        if (run.aborted) {
          toolCall.status = "rejected";
          toolCall.result = { error: "Killed by user (Stop)." };
        } else {
          toolCall.status = res.success ? "completed" : "failed";
        }
        toolCall.result = {
          output: res.stdout + (res.stderr ? `\nSTDERR:\n${res.stderr}` : ""),
          executionTimeMs: Number(res.execution_time_ms),
        };
      } else if (toolCall.name === "read_file") {
        const res = await TauriBridge.readFileContent(
          toolCall.arguments.path,
          toolCall.arguments.max_lines
        );
        toolCall.status = "completed";
        toolCall.result = {
          output: res.content,
        };
      } else if (toolCall.name === "write_file") {
        // Approval was bound to the reviewed proposal. Verify the file still
        // matches what was shown; a changed file makes the proposal stale and
        // sends the user back to review instead of overwriting blindly.
        const reviewed = toolCall.result?.diff;
        let currentContent: string | null = null;
        try {
          currentContent = (await TauriBridge.readFileContent(toolCall.arguments.path)).content;
        } catch {
          currentContent = null; // still missing
        }

        // Stop may land while the re-read above is in flight — it must win
        // over the mutation that was about to follow it.
        if (run.aborted) {
          toolCall.status = "rejected";
          toolCall.result = {
            error: "Cancelled by user (Stop). Nothing was written.",
            ...(reviewed ? { diff: reviewed } : {}),
          };
        } else {
          const stale = reviewed
            ? reviewed.existed
              ? currentContent !== reviewed.before
              : currentContent !== null
            : true; // no recorded proposal — refuse to write blind

          if (stale) {
            toolCall.status = "failed";
            toolCall.result = {
              error:
                "File changed after review — this proposal is stale and nothing was written. Ask the agent to review the file and propose the change again.",
              diff: reviewed,
            };
          } else {
            const res = await TauriBridge.writeFileContent(
              toolCall.arguments.path,
              toolCall.arguments.content,
              decision
            );
            toolCall.status = res.success ? "completed" : "failed";
            toolCall.result = {
              output: `Wrote ${res.size_bytes} bytes to ${res.path}`,
              diff: reviewed,
            };
          }
        }
      } else if (toolCall.name === "list_directory") {
        const entries = await TauriBridge.listDirEntries(toolCall.arguments.path);
        toolCall.status = "completed";
        toolCall.result = {
          output: entries
            .map((e) => `${e.is_dir ? "📁" : "📄"} ${e.name} (${e.size} bytes)`)
            .join("\n"),
        };
      }
    } catch (err: any) {
      toolCall.status = "failed";
      toolCall.result = {
        error: err.message || String(err),
      };
    }

    onUpdate(toolCall);
  }
}

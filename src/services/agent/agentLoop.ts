import {
  BotPersona,
  AIModel,
  TranscriptEntry,
  VaultConfig,
  ToolCallItem,
} from "../../types";
import { streamChatCompletion, ChatMessagePayload } from "../ai/streamClient";
import { TauriBridge } from "../tauri/bridge";

export class AgentLoop {
  private abortController: AbortController | null = null;
  /** True once abort() fires; stays set for the whole turn chain. */
  private aborted = false;
  /** Resolvers for approvals still awaiting a user decision. */
  private pendingApprovals = new Set<(approved: boolean) => void>();
  /** Shell executions currently running, so Stop can kill them natively. */
  private runningShellCalls = new Map<string, true>();

  public abort() {
    this.aborted = true;
    this.abortController?.abort();
    // Pending approvals resolve as "denied" so Stop actually stops.
    for (const resolve of this.pendingApprovals) resolve(false);
    this.pendingApprovals.clear();
    // Kill any shell command still running on the host.
    for (const callId of this.runningShellCalls.keys()) {
      TauriBridge.killShellCommand(callId).catch(() => {
        // Already finished or unsupported — the bounded timeout still applies.
      });
    }
    this.runningShellCalls.clear();
  }

  public async runTurn(
    threadId: string,
    transcript: TranscriptEntry[],
    bot: BotPersona,
    model: AIModel,
    vault: VaultConfig,
    onUpdateEntry: (entry: TranscriptEntry) => void,
    onAddEntry: (entry: TranscriptEntry) => void,
    onNeedsApproval: (toolCall: ToolCallItem, resolve: (approved: boolean) => void) => void,
    isContinuation = false
  ): Promise<void> {
    if (!isContinuation) this.aborted = false;

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

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
        signal
      );

      if (this.aborted || signal.aborted) return;

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
          if (this.aborted || signal.aborted) return;
          const tc = toolCalls[i];
          await this.executeToolWithSafety(
            tc,
            bot,
            vault,
            (updatedTc) => {
              toolCalls[i] = updatedTc;
              onUpdateEntry({
                ...assistantEntry,
                toolCalls: [...toolCalls],
              });
            },
            onNeedsApproval
          );
        }

        if (this.aborted || signal.aborted) return;

        // Continue the turn with tool results
        const updatedTranscript = [
          ...transcript,
          {
            ...assistantEntry,
            content: currentContent,
            toolCalls: [...toolCalls],
          },
        ];

        await this.runTurn(
          threadId,
          updatedTranscript,
          bot,
          model,
          vault,
          onUpdateEntry,
          onAddEntry,
          onNeedsApproval,
          true
        );
      }
    } catch (err: any) {
      if (this.aborted || signal.aborted) return;
      // streamClient rethrows provider failures with recovery text in the message
      onUpdateEntry({
        ...assistantEntry,
        content:
          currentContent +
          (currentContent ? "\n\n" : "") +
          `**Error:** ${err.message}`,
        isThinkingActive: false,
        toolCalls: [...toolCalls],
      });
    } finally {
      if (!isContinuation) {
        this.abortController = null;
        this.pendingApprovals.clear();
      }
    }
  }

  private async executeToolWithSafety(
    toolCall: ToolCallItem,
    bot: BotPersona,
    vault: VaultConfig,
    onUpdate: (tc: ToolCallItem) => void,
    onNeedsApproval: (toolCall: ToolCallItem, resolve: (approved: boolean) => void) => void
  ): Promise<void> {
    // 1. Safety evaluation — decision provenance feeds the audit log
    let requiresApproval = false;
    let safetyReason = "Read-only action";
    let safetyTier: import("../../types").CommandSafetyTier = "Safe";
    let decision = "auto_safe";

    if (toolCall.name === "execute_shell") {
      const safety = await TauriBridge.checkShellSafety(toolCall.arguments.command || "");
      safetyTier = safety.tier;
      safetyReason = safety.reason;
      if (safety.standing_grant) {
        // Exact match on a prior "Always allow"; deny rules ran first in Rust.
        requiresApproval = false;
        decision = "standing_grant";
      } else {
        requiresApproval =
          safety.requires_confirmation || !vault.autoApproveSafeTools;
        decision = "auto_safe";
      }
    } else if (toolCall.name === "write_file") {
      safetyTier = "Mutative";
      safetyReason = "Modifies filesystem content";
      // Auto-approve only covers read-only commands; writes always ask.
      requiresApproval = true;
    }

    void bot;
    toolCall.safetyTier = safetyTier;
    toolCall.safetyReason = safetyReason;

    if (requiresApproval) {
      toolCall.status = "pending_approval";
      onUpdate(toolCall);

      // The wrapped resolver also unregisters itself from pendingApprovals,
      // so abort() only cancels approvals still awaiting a decision.
      const approved = await new Promise<boolean>((resolve) => {
        const wrapped = (v: boolean) => {
          this.pendingApprovals.delete(wrapped);
          resolve(v);
        };
        this.pendingApprovals.add(wrapped);
        onNeedsApproval(toolCall, wrapped);
      });

      if (!approved) {
        toolCall.status = "rejected";
        toolCall.result = {
          error: this.aborted
            ? "Cancelled by user (Stop)."
            : "Action rejected by user.",
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

    if (this.aborted) {
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
        this.runningShellCalls.set(toolCall.id, true);
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
          this.runningShellCalls.delete(toolCall.id);
        }
        if (this.aborted) {
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
        let beforeContent = "";
        try {
          const prev = await TauriBridge.readFileContent(toolCall.arguments.path);
          beforeContent = prev.content;
        } catch {
          beforeContent = ""; // new file
        }

        const res = await TauriBridge.writeFileContent(
          toolCall.arguments.path,
          toolCall.arguments.content,
          decision
        );
        toolCall.status = res.success ? "completed" : "failed";
        toolCall.result = {
          output: `Wrote ${res.size_bytes} bytes to ${res.path}`,
          diff: {
            before: beforeContent,
            after: toolCall.arguments.content,
            path: res.path,
          },
        };
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

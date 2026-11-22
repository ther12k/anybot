import React, { useState, useEffect, useRef } from "react";
import "./components/Workspace/warm-workspace.css";
import { MessageItem } from "./components/Chat/MessageItem";
import { Composer } from "./components/Composer/Composer";
import { BotDrawer } from "./components/BotDrawer/BotDrawer";
import { SettingsModal } from "./components/SettingsModal/SettingsModal";
import { NewRoomModal } from "./components/NewRoomModal/NewRoomModal";
import { AnyBotCharacter, type TaviMood } from "./components/Tavi/AnyBotCharacter";
import { DEFAULT_BOTS } from "./data/defaultBots";
import { DEFAULT_WORKFLOWS } from "./data/defaultWorkflows";
import { AVAILABLE_MODELS, isCliModel } from "./services/ai/models";
import { AgentLoop, type RunOutcome, type DelegateResult } from "./services/agent/agentLoop";
import { streamChatCompletion } from "./services/ai/streamClient";
import { TauriBridge, isTauriEnvironment, observeAuditRecordingFailure } from "./services/tauri/bridge";
import { getWorkflowPause, isWorkflowGate, modelCanRunWorkflow, reconcileWorkflows, runWorkflowSteps } from "./services/workflow";
import {
  BotPersona,
  Thread,
  TranscriptEntry,
  VaultConfig,
  AIModel,
  BotWorkflow,
  ToolCallItem,
} from "./types";
import { ArrowDown, ArrowLeft, Bot, ChevronDown, Download, Folder, GitFork, MoreHorizontal, PanelRight, Sparkles, Users } from "lucide-react";
import WorkspacePages from "./components/Workspace/WorkspacePages";
import { Action, ChatRail, Inspector, WorkspaceDialog, WorkspaceSidebar, WorkspaceTitlebar, type RunStatus, type WorkflowProgress, type WorkspaceView } from "./components/Workspace/WorkspaceShell";

/** Light shape validation — a JSON file that parses but has the wrong
    shape must fall back to defaults instead of corrupting the app. */
function loadStored<T>(key: string, isValid: (v: any) => boolean, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return isValid(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}
const isBotList = (v: any) =>
  Array.isArray(v) && v.every((b) => b && typeof b.id === "string" && typeof b.name === "string");
const isThreadList = (v: any) =>
  Array.isArray(v) && v.every((t) => t && typeof t.id === "string" && typeof t.botId === "string");
const isTranscriptMap = (v: any) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v).every(
    (arr) => Array.isArray(arr) && arr.every((e) => e && typeof e.id === "string" && typeof e.role === "string")
  );
};
const isWorkflowList = (v: any) =>
  Array.isArray(v) &&
  v.every((w) => w && typeof w.id === "string" && typeof w.name === "string" &&
    Array.isArray(w.steps) &&
    w.steps.every((s: unknown) => typeof s === "string" || isWorkflowGate(s)));

function userEntry(threadId: string, content: string): TranscriptEntry {
  return { id: `user_${crypto.randomUUID()}`, threadId, role: "user", content, timestamp: Date.now() };
}

export const App: React.FC = () => {
  // State — v4: capability-flagged starter prompts; custom bots survive
  const [bots, setBots] = useState<BotPersona[]>(() => {
    const saved = loadStored<BotPersona[] | null>("anybot_bots_v4", isBotList, null);
    if (saved) return saved;
    const older =
      localStorage.getItem("anybot_bots_v3") ||
      localStorage.getItem("anybot_bots_v2") ||
      localStorage.getItem("anybot_bots");
    if (older) {
      try {
        const oldBots: BotPersona[] = JSON.parse(older);
        if (Array.isArray(oldBots)) {
          const customOnly = oldBots.filter((b) => b?.isCustom && typeof b.id === "string");
          return [...DEFAULT_BOTS, ...customOnly];
        }
      } catch {}
    }
    return DEFAULT_BOTS;
  });

  const [activeBot, setActiveBot] = useState<BotPersona>(bots[0] ?? DEFAULT_BOTS[0]);

  const [threads, setThreads] = useState<Thread[]>(() =>
    loadStored<Thread[]>("anybot_threads", isThreadList, [])
  );

  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const selectedThreadRef = useRef<string | null>(null);
  selectedThreadRef.current = activeThreadId;

  const [transcripts, setTranscripts] = useState<Record<string, TranscriptEntry[]>>(() =>
    loadStored<Record<string, TranscriptEntry[]>>("anybot_transcripts", isTranscriptMap, {})
  );

  // One-click multi-step workflows (Grok Bot-style task chains)
  const [workflows] = useState(() =>
    reconcileWorkflows(loadStored("anybot_workflows_v1", isWorkflowList, DEFAULT_WORKFLOWS))
  );
  const [workflowProgress, setWorkflowProgress] = useState<(WorkflowProgress & { threadId: string }) | null>(null);
  const [workflowHistory, setWorkflowHistory] = useState<Record<string, WorkflowProgress>>({});
  const [workflowSaveError, setWorkflowSaveError] = useState<{ threadId: string; message: string } | null>(null);
  const workflowRunningRef = useRef(false);
  const stopRunRef = useRef(false);

  const [vault, setVault] = useState<VaultConfig>({
    autoApproveSafeTools: true,
  });

  const [selectedModel, setSelectedModel] = useState<AIModel>(() => {
    return (
      AVAILABLE_MODELS.find((m) => m.id === activeBot.defaultModel) ||
      AVAILABLE_MODELS[0]
    );
  });

  const [systemInfo, setSystemInfo] = useState<{
    os: string;
    username: string;
    cwd: string;
    homeDir: string;
  } | null>(null);

  const [isGenerating, setIsGenerating] = useState(false);
  // Honest stop: stays true from clicking Stop until the run has settled.
  const [isStopping, setIsStopping] = useState(false);
  const [editingBot, setEditingBot] = useState<BotPersona | null>(null);
  const [view, setView] = useState<WorkspaceView>("chats");
  const [auditRecordingFailed, setAuditRecordingFailed] = useState(false);
  useEffect(() => observeAuditRecordingFailure(() => setAuditRecordingFailed(true)), []);
  const [dialog, setDialog] = useState<"help" | "agent" | "model" | "thread" | null>(null);
  const [workflowModel, setWorkflowModel] = useState<AIModel | null>(null);
  const [inspectorHidden, setInspectorHidden] = useState(false);
  const [inspectorOverlay, setInspectorOverlay] = useState(false);
  const [overlayLayout, setOverlayLayout] = useState(() => window.matchMedia("(max-width: 1170px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1170px)");
    const onChange = (event: MediaQueryListEvent) => {
      setOverlayLayout(event.matches);
      setInspectorOverlay(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const [mobileRail, setMobileRail] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, RunOutcome>>({});

  // Autoscroll only while the reader is near the bottom
  const [isNearBottom, setIsNearBottom] = useState(true);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Undo-able chat deletion: keep the removed thread for a grace period
  const [deletedChat, setDeletedChat] = useState<{
    thread: Thread;
    entries: TranscriptEntry[];
  } | null>(null);
  const undoTimerRef = useRef<number | undefined>(undefined);

  const approvalResolversRef = useRef<Map<string, (approved: boolean, revision?: string) => void>>(
    new Map()
  );

  const agentLoopRef = useRef<AgentLoop>(new AgentLoop());
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Stable mirror of transcripts/threads for effects that must not re-fire
  // per token — Team Room runners also re-read transcriptsRef between
  // responders so bot N sees bot N-1's reply in its history.
  const transcriptsRef = useRef(transcripts);
  const updateTranscript = (id: string, update: (entries: TranscriptEntry[]) => TranscriptEntry[]) => {
    const previous = transcriptsRef.current;
    const next = { ...previous, [id]: update(previous[id] ?? []) };
    transcriptsRef.current = next;
    setTranscripts(next);
  };
  const threadsRef = useRef(threads);
  const updateThreads = (update: (list: Thread[]) => Thread[]) => {
    const next = update(threadsRef.current);
    threadsRef.current = next;
    setThreads(next);
  };

  const saveWorkflowCheckpoint = (id: string, pendingWorkflow: Thread["pendingWorkflow"], decision?: string) => {
    const nextThreads = threadsRef.current.map((t) => t.id === id ? { ...t, pendingWorkflow } : t);
    const entries = transcriptsRef.current[id] ?? [];
    const nextTranscripts = decision
      ? { ...transcriptsRef.current, [id]: [...entries, userEntry(id, decision)] }
      : transcriptsRef.current;
    try {
      // Keep the evidence and consume the checkpoint before dispatching the
      // next step. A reload must not leave a live, already-used decision.
      if (pendingWorkflow || decision) localStorage.setItem("anybot_transcripts", JSON.stringify(nextTranscripts));
      localStorage.setItem("anybot_threads", JSON.stringify(nextThreads));
    } catch (error) {
      console.error("Failed to save workflow checkpoint:", error);
      setWorkflowSaveError({ threadId: id, message: "Couldn’t save the workflow checkpoint. No further steps were sent." });
      return false;
    }
    updateThreads(() => nextThreads);
    if (decision) {
      transcriptsRef.current = nextTranscripts;
      setTranscripts(nextTranscripts);
    }
    setWorkflowSaveError(null);
    return true;
  };

  /** Persona running the CURRENT turn (Team Rooms): delegation audit
   *  provenance names the actual speaker, not the sidebar selection. */
  const currentRunBotIdRef = useRef<string | null>(null);
  const currentRunModelRef = useRef<AIModel | null>(null);
  const [isRoomModalOpen, setIsRoomModalOpen] = useState(false);

  useEffect(() => {
    async function init() {
      try {
        const sys = await TauriBridge.getSystemInfo();
        setSystemInfo({
          os: sys.os,
          username: sys.username,
          cwd: sys.cwd,
          homeDir: sys.home_dir,
        });

        const vaultJson = await TauriBridge.loadVaultConfig();
        if (vaultJson && vaultJson !== "{}") {
          const parsed: VaultConfig = JSON.parse(vaultJson);
          if (!isTauriEnvironment()) {
            delete parsed.anthropicApiKey;
            delete parsed.openaiApiKey;
            delete parsed.grokApiKey;
          }
          setVault(parsed);
          if (parsed.selectedModel) {
            const found = AVAILABLE_MODELS.find((m) => m.id === parsed.selectedModel);
            if (found && !threadsRef.current.some((t) => t.id === selectedThreadRef.current)) setSelectedModel(found);
          }
        }
      } catch (e) {
        console.error("Initialization error:", e);
      }
    }
    init();
  }, []);

  useEffect(() => {
    localStorage.setItem("anybot_bots_v4", JSON.stringify(bots));
  }, [bots]);

  useEffect(() => {
    localStorage.setItem("anybot_workflows_v1", JSON.stringify(workflows));
  }, [workflows]);

  useEffect(() => {
    try {
      localStorage.setItem("anybot_threads", JSON.stringify(threadsRef.current));
    } catch (error) {
      console.error("Failed to persist conversations:", error);
    }
  }, [threads]);

  // Streaming writes a lot: debounce so each token doesn't serialize the
  // whole history synchronously.
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem("anybot_transcripts", JSON.stringify(transcriptsRef.current));
      } catch (e) {
        console.error("Failed to persist transcript:", e);
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [transcripts]);

  // Startup reconciliation: approvals live only in memory, so a pending
  // proposal that survived a reload can never be resolved. Mark those runs
  // interrupted instead of freezing the task behind a dead approval.
  useEffect(() => {
    let changed = false;
    const next: Record<string, TranscriptEntry[]> = {};
    for (const [threadId, list] of Object.entries(transcriptsRef.current)) {
      next[threadId] = list.map((entry) => {
        if (!entry.toolCalls?.some((tc) => tc.status === "pending_approval")) return entry;
        changed = true;
        return {
          ...entry,
          toolCalls: entry.toolCalls.map((tc) =>
            tc.status === "pending_approval"
              ? {
                  ...tc,
                  status: "failed" as const,
                  result: {
                    ...(tc.result?.diff ? { diff: tc.result.diff } : {}),
                    error:
                      "AnyBot restarted while this action was waiting for review — nothing ran. Ask the agent to propose it again.",
                  },
                }
              : tc
          ),
        };
      });
    }
    if (changed) {
      transcriptsRef.current = next;
      setTranscripts(next);
      console.info("Reconciled interrupted approvals from the previous session.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autoscroll only while the reader is near the bottom; switching tasks
  // always resets to "follow latest".
  useEffect(() => {
    setIsNearBottom(true);
  }, [activeThreadId]);

  useEffect(() => {
    if (!isNearBottom) return;
    const prefersMotion = window.matchMedia(
      "(prefers-reduced-motion: no-preference)"
    ).matches;
    transcriptEndRef.current?.scrollIntoView({
      behavior: prefersMotion ? "smooth" : "auto",
    });
  }, [transcripts, activeThreadId, isNearBottom, view]);

  const handleTranscriptScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    setIsNearBottom(nearBottom);
  };

  const jumpToLatest = () => {
    setIsNearBottom(true);
    const prefersMotion = window.matchMedia(
      "(prefers-reduced-motion: no-preference)"
    ).matches;
    transcriptEndRef.current?.scrollIntoView({
      behavior: prefersMotion ? "smooth" : "auto",
    });
  };

  // ---- Derived run context -------------------------------------------------
  const currentTranscript = activeThreadId ? transcripts[activeThreadId] || [] : [];
  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null;
  /** Team Room members of the active thread (empty for 1:1 chats). */
  const roomMembers: BotPersona[] =
    activeThread?.isRoom && activeThread.participantBotIds
      ? (activeThread.participantBotIds
          .map((id) => bots.find((b) => b.id === id))
          .filter(Boolean) as BotPersona[])
      : [];

  const resumableWorkflow = (thread: Thread | null) => {
    const pause = getWorkflowPause(workflows, thread?.pendingWorkflow);
    if (!thread || !pause || thread.isRoom || !bots.some((bot) => bot.id === thread.botId)) return null;
    const model = AVAILABLE_MODELS.find(({ id }) => id === thread.modelId);
    return model && modelCanRunWorkflow(pause.workflow, model) ? pause : null;
  };
  const pausedWorkflow = resumableWorkflow(activeThread);
  const activeWorkflowRun = workflowProgress?.threadId === activeThreadId ? workflowProgress : undefined;
  const threadWorkflow: WorkflowProgress | undefined = activeWorkflowRun ?? (pausedWorkflow ? {
    name: pausedWorkflow.workflow.name,
    step: pausedWorkflow.nextStep,
    total: pausedWorkflow.workflow.steps.length,
    state: pausedWorkflow.gate.kind === "approval" ? "awaiting_approval" : "awaiting_input",
  } : activeThreadId ? workflowHistory[activeThreadId] : undefined);
  const busy = isGenerating || workflowProgress !== null;
  const pending = currentTranscript.flatMap((e) => e.toolCalls ?? []).filter((tc) => tc.status === "pending_approval");
  const hasRunningTool = currentTranscript.some((e) => e.toolCalls?.some((tc) => tc.status === "running"));
  const lastOutcome = activeThreadId ? outcomes[activeThreadId] : undefined;
  const runStatus: RunStatus = (() => {
    if (isStopping) return { label: "Stopping…", mood: "working" };
    if (pending.length) return { label: "Waiting for your approval", mood: "approval" };
    if (activeWorkflowRun) return { label: `${activeWorkflowRun.name} · Step ${activeWorkflowRun.step}/${activeWorkflowRun.total}`, mood: "working" };
    if (isGenerating) return { label: "Working on your request", mood: hasRunningTool ? "working" : "thinking" };
    if (pausedWorkflow?.gate.kind === "approval") return { label: "Waiting for plan approval", mood: "approval" };
    if (pausedWorkflow) return { label: "Waiting for your input", mood: "listening" };
    if (activeThread?.pendingWorkflow) return { label: "Workflow can’t resume", mood: "error" };
    if (lastOutcome === "completed") return { label: "Completed", mood: "success" };
    if (lastOutcome === "cancelled") return { label: "Stopped by you", mood: "idle" };
    if (lastOutcome === "failed") return { label: "Something needs attention", mood: "error" };
    return { label: "Ready when you are", mood: "idle" };
  })();
  const workspace = systemInfo?.cwd.split(/[\\/]/).filter(Boolean).pop() || "Local workspace";
  const inConversation = view === "chats" || (view === "rooms" && !!activeThread?.isRoom);
  const openInspector = overlayLayout ? inspectorOverlay : !inspectorHidden;
  const toggleInspector = () => {
    if (overlayLayout) {
      setInspectorOverlay(!inspectorOverlay);
      setMobileRail(false);
    } else {
      setInspectorHidden(!inspectorHidden);
    }
  };

  // Welcome-screen Tavi: one wave on arrival, then settle.
  const [welcomeMood, setWelcomeMood] = useState<TaviMood>("wave");
  useEffect(() => {
    setWelcomeMood("wave");
    const t = window.setTimeout(() => setWelcomeMood("idle"), 1500);
    return () => window.clearTimeout(t);
  }, [activeThreadId]);

  // ---- Handlers ------------------------------------------------------------

  const createThread = (bot: BotPersona, model: AIModel, title = "New chat", roomMembers?: string[]) => {
    const now = Date.now();
    const thread: Thread = {
      id: `thread_${crypto.randomUUID()}`, botId: bot.id, modelId: model.id,
      title, createdAt: now, updatedAt: now,
      ...(roomMembers ? { isRoom: true, participantBotIds: roomMembers } : {}),
    };
    updateThreads((prev) => [thread, ...prev]);
    setActiveThreadId(thread.id);
    setActiveBot(bot);
    setSelectedModel(model);
    setView(roomMembers ? "rooms" : "chats");
    setMobileRail(false);
    return thread;
  };

  const handleNewThread = () => {
    if (!busy) createThread(activeBot, selectedModel);
  };

  const handleDeleteThread = (threadId: string) => {
    if (busy) return;
    const thread = threads.find((t) => t.id === threadId);
    updateThreads((prev) => prev.filter((t) => t.id !== threadId));
    const nextTranscripts = { ...transcripts };
    delete nextTranscripts[threadId];
    transcriptsRef.current = nextTranscripts;
    setTranscripts(nextTranscripts);
    if (activeThreadId === threadId) setActiveThreadId(null);

    // Offer undo instead of a confirmation wall
    if (thread) {
      setDeletedChat({ thread, entries: transcripts[threadId] || [] });
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = window.setTimeout(
        () => setDeletedChat(null),
        6000
      );
    }
  };

  const handleUndoDelete = () => {
    if (!deletedChat) return;
    window.clearTimeout(undoTimerRef.current);
    updateThreads((prev) => [deletedChat.thread, ...prev]);
    updateTranscript(deletedChat.thread.id, () => deletedChat.entries);
    setDeletedChat(null);
  };

  const handleTogglePinThread = (threadId: string) => {
    updateThreads((prev) => prev.map((t) => t.id === threadId ? { ...t, isPinned: !t.isPinned } : t));
  };

  /** Opening a task restores ITS agent and model — history keeps its identity. */
  const handleSelectThread = (threadId: string) => {
    if (busy) return;
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) return;
    setActiveThreadId(threadId);
    setView(thread.isRoom ? "rooms" : "chats");
    setMobileRail(false);
    const threadBot = bots.find((b) => b.id === thread.botId);
    if (threadBot) setActiveBot(threadBot);
    const modelId = thread.modelId ?? threadBot?.defaultModel;
    const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
    if (model) setSelectedModel(model);
  };

  // Fork only conversation text. Native tool tokens, hidden thinking and
  // approval history belong to the original run and must not be replayed.
  const forkThread = (thread: Thread, bot: BotPersona, model: AIModel, untilId?: string) => {
    const fork = createThread(bot, model, `${thread.title || "Conversation"} · fork`, thread.isRoom ? thread.participantBotIds : undefined);
    const cutoff = untilId ? currentTranscript.findIndex((e) => e.id === untilId) + 1 : currentTranscript.length;
    updateTranscript(fork.id, () => currentTranscript.slice(0, cutoff)
      .filter((entry) => (entry.role === "user" || entry.role === "assistant") && entry.content.trim())
      .map(({ role, content, timestamp, authorBotId }) => ({
        id: crypto.randomUUID(), threadId: fork.id, role, content, timestamp,
        authorBotId: role === "assistant" ? authorBotId ?? thread.botId : undefined,
      })));
  };

  const handleSelectModel = (model: AIModel) => {
    if (busy || model.id === selectedModel.id) return;
    if (activeThread && currentTranscript.length) {
      forkThread(activeThread, activeBot, model);
      return;
    }
    setSelectedModel(model);
    if (activeThreadId) updateThreads((prev) => prev.map((t) => t.id === activeThreadId ? { ...t, modelId: model.id } : t));
  };

  const handleSelectBot = (bot: BotPersona) => {
    if (busy) return;
    const model = AVAILABLE_MODELS.find((m) => m.id === bot.defaultModel) ?? selectedModel;
    if (activeThread && !activeThread.isRoom && activeThread.botId !== bot.id && currentTranscript.length) {
      forkThread(activeThread, bot, model);
    } else if (activeThread && !activeThread.isRoom) {
      if (activeThread.botId !== bot.id) {
        updateThreads((prev) => prev.map((t) => t.id === activeThread.id ? { ...t, botId: bot.id, modelId: model.id } : t));
        setSelectedModel(model);
      }
      setActiveBot(bot);
      setView("chats");
    } else {
      createThread(bot, model);
    }
  };

  const handleCreateNewBot = () => {
    const newCustomBot: BotPersona = {
      id: `custom_bot_${Date.now()}`,
      name: "My Custom Agent",
      slug: `custom-${Date.now().toString().slice(-4)}`,
      description: "Custom autonomous agent with specialized instructions.",
      avatar: "🤖",
      category: "general",
      tags: ["custom"],
      defaultModel: selectedModel.id,
      temperature: 0.7,
      autoApproveSafeTools: true,
      isCustom: true,
      systemPrompt: `You are a custom AI assistant with native access to local tools and terminal commands. Always be helpful, precise, and thoughtful.`,
    };
    setBots((prev) => [...prev, newCustomBot]);
    setEditingBot(newCustomBot);
  };

  /** Bot-to-bot delegation: the target persona answers in ONE tool-less
   *  chat turn — it can neither touch this machine nor delegate further.
   *  The persona's default model is used when its provider has a key;
   *  otherwise the sub-run falls back to the conversation's model. */
  const handleDelegateTask = async (
    botRef: string,
    task: string,
    signal: AbortSignal
  ): Promise<DelegateResult> => {
    const key = botRef.trim().toLowerCase();
    const target = bots.find(
      (b) => b.slug.toLowerCase() === key || b.name.toLowerCase() === key
    );
    if (!target) {
      return {
        ok: false,
        error: `Unknown bot "${botRef}". Available bots: ${bots.map((b) => b.name).join(", ")}.`,
      };
    }
    // The delegator is the bot actually speaking in this run (Team Rooms),
    // else the thread's bot — never merely the sidebar selection.
    const threadBotId = threads.find((t) => t.id === activeThreadId)?.botId ?? activeBot.id;
    const fromBot =
      bots.find((b) => b.id === currentRunBotIdRef.current) ??
      bots.find((b) => b.id === threadBotId) ??
      activeBot;
    if (target.id === fromBot.id) {
      return { ok: false, error: `You are already ${target.name} — answer this yourself.` };
    }
    if (!task.trim()) {
      return { ok: false, error: "Delegation task is empty." };
    }

    const canDelegateTo = (m: AIModel) => !isCliModel(m) && (
      m.provider === "ollama" ||
      (m.provider === "anthropic" && !!vault.anthropicApiKey?.trim()) ||
      (m.provider === "openai" && !!vault.openaiApiKey?.trim()) ||
      (m.provider === "grok" && !!vault.grokApiKey?.trim())
    );
    const preferred = AVAILABLE_MODELS.find((m) => m.id === target.defaultModel && canDelegateTo(m));
    const fallback = currentRunModelRef.current ?? selectedModel;
    const model = preferred ?? (canDelegateTo(fallback) ? fallback : null);
    if (!model) {
      return {
        ok: false,
        botName: target.name,
        error: "Tool-less delegation requires a configured API model or an Ollama model. CLI agents manage their own tools.",
      };
    }

    const audit = (outcome: "completed" | "failed" | "cancelled", error?: string) =>
      TauriBridge.recordDelegationAudit(
        fromBot.name,
        target.name,
        model.name,
        outcome,
        error ?? null
      ).catch(() => {});

    let reply = "";
    try {
      await streamChatCompletion(
        model,
        vault,
        [{ role: "user", content: task }],
        target.systemPrompt,
        { onContentDelta: (delta) => { reply += delta; } },
        signal,
        target.temperature,
        { includeTools: false }
      );
    } catch (err: any) {
      const cancelled = signal.aborted;
      audit(cancelled ? "cancelled" : "failed", String(err?.message ?? err).slice(0, 300));
      return {
        ok: false,
        botName: target.name,
        modelUsed: model.name,
        error: cancelled ? "Cancelled by user (Stop)." : String(err?.message ?? err),
      };
    }
    if (signal.aborted) {
      audit("cancelled");
      return { ok: false, botName: target.name, modelUsed: model.name, error: "Cancelled by user (Stop)." };
    }
    audit("completed");
    return { ok: true, botName: target.name, modelUsed: model.name, reply: reply.trim() };
  };

  // Keep the resolver current: it closes over the latest roster, keys, and
  // model, so a delegation mid-conversation never uses stale state.
  useEffect(() => {
    agentLoopRef.current.delegateResolver = handleDelegateTask;
  });

  /** Team Rooms: resolve who answers a message. @slug mentions are
   *  authoritative (slugs are unique — the autocomplete inserts them);
   *  hand-typed @FirstName only counts when it matches exactly ONE member
   *  (so "@grok" never drags in "Grok (Fun Mode)"). Every mentioned member
   *  responds, capped at 3; no mention → the room's primary bot. */
  const resolveRoomResponders = (text: string, thread: Thread): BotPersona[] => {
    const participants = (thread.participantBotIds || [])
      .map((id) => bots.find((b) => b.id === id))
      .filter(Boolean) as BotPersona[];
    const mentions = [...text.matchAll(/(?:^|[^\w@])@([\w-]+)/g)].map((match) => match[1].toLowerCase());
    const mentioned = new Set<BotPersona>();
    for (const mention of mentions) {
      const bySlug = participants.find((b) => b.slug.toLowerCase() === mention);
      const byName = participants.filter((b) => b.name.split(/\s+/)[0].toLowerCase() === mention);
      if (bySlug) mentioned.add(bySlug);
      else if (byName.length === 1) mentioned.add(byName[0]);
    }
    const responders = mentioned.size ? [...mentioned].slice(0, 3) : participants.slice(0, 1);
    // Fallback when the primary bot is no longer on the roster.
    return responders.length > 0 ? responders : [activeBot];
  };

  const handleCreateRoom = (name: string, memberIds: string[]) => {
    const primary = bots.find((bot) => bot.id === memberIds[0]);
    if (!name.trim() || memberIds.length < 2 || !primary || busy) return;
    createThread(primary, selectedModel, name.trim(), memberIds);
    setIsRoomModalOpen(false);
  };

  const sendTurn = async (text: string, thread: Thread): Promise<RunOutcome | null> => {
    if (agentLoopRef.current.isBusy()) return null;
    const title = text.slice(0, 45) + (text.length > 45 ? "…" : "");
    const currentThreadId = thread.id;
    const threadModel = AVAILABLE_MODELS.find((model) => model.id === thread.modelId) ?? selectedModel;
    const threadBot = bots.find((b) => b.id === thread.botId) ?? activeBot;
    const threadHistory = transcriptsRef.current[currentThreadId] ?? [];
    updateThreads((prev) => prev.map((t) => t.id === currentThreadId ? {
      ...t, title: !t.isRoom && t.title === "New chat" && !threadHistory.length ? title : t.title, updatedAt: Date.now(),
    } : t));

    const historyWithPrompt = [...threadHistory, userEntry(currentThreadId, text)];
    updateTranscript(currentThreadId, () => historyWithPrompt);
    const responders = thread.isRoom ? resolveRoomResponders(text, thread) : [threadBot];
    const approvals = new Set<string>();
    const onUpdateEntry = (updated: TranscriptEntry) => {
      updateTranscript(currentThreadId, (list) => list.map((entry) => entry.id === updated.id ? updated : entry));
    };
    const onAddEntry = (entry: TranscriptEntry) => updateTranscript(currentThreadId, (list) => [...list, entry]);
    const onNeedsApproval = (toolCall: ToolCallItem, resolve: (approved: boolean, revision?: string) => void) => {
      approvals.add(toolCall.id);
      approvalResolversRef.current.set(toolCall.id, resolve);
    };

    currentRunModelRef.current = threadModel;
    setIsGenerating(true);
    setIsStopping(false);

    try {
      let finalOutcome: RunOutcome = "completed";
      for (let i = 0; i < responders.length; i++) {
        // Stop breaks the responder chain honestly (workflow pattern).
        if (i > 0 && stopRunRef.current) {
          finalOutcome = "cancelled";
          break;
        }
        const responder = responders[i];
        currentRunBotIdRef.current = responder.id;
        // Re-read live history so responder N sees responder N-1's reply.
        const history =
          i === 0 ? historyWithPrompt : [...(transcriptsRef.current[currentThreadId] || [])];
        // Room members answer with room context: who else is here and that
        // prior replies in the transcript came from teammates.
        const effectiveBot: BotPersona = thread?.isRoom
          ? {
              ...responder,
              systemPrompt:
                `[You are "${responder.name}" in the team room "${thread.title}". ` +
                `Room members: ${responders.length > 0 && thread.participantBotIds
                  ?.map((id) => bots.find((b) => b.id === id)?.name)
                  .filter(Boolean)
                  .join(", ")}. ` +
                `The user's message may @mention you or other agents; earlier replies from other agents are visible in the conversation — build on them instead of repeating. Stay in your role and answer as ${responder.name}.]\n\n` +
                responder.systemPrompt,
            }
          : responder;
        const outcome = await agentLoopRef.current.runTurn(
          currentThreadId,
          history,
          effectiveBot,
          threadModel,
          vault,
          onUpdateEntry,
          onAddEntry,
          onNeedsApproval,
          thread?.isRoom ? responder.id : undefined
        );
        if (outcome === "cancelled") {
          finalOutcome = "cancelled";
          break;
        }
        if (outcome === "failed") {
          finalOutcome = "failed";
          break;
        }
      }
      setOutcomes((prev) => ({ ...prev, [currentThreadId]: finalOutcome }));
      return finalOutcome;
    } catch (error) {
      console.error("Run failed:", error);
      setOutcomes((prev) => ({ ...prev, [currentThreadId]: "failed" }));
      return "failed";
    } finally {
      currentRunBotIdRef.current = null;
      currentRunModelRef.current = null;
      approvals.forEach((id) => approvalResolversRef.current.delete(id));
      setIsGenerating(false);
      if (!workflowRunningRef.current) setIsStopping(false);
    }
  };

  const handleStop = () => {
    stopRunRef.current = true;
    if (agentLoopRef.current.abort() || workflowRunningRef.current) setIsStopping(true);
  };

  const runWorkflowChain = async (wf: BotWorkflow, thread: Thread, startIndex: number) => {
    const { id: threadId } = thread;
    workflowRunningRef.current = true;
    stopRunRef.current = false;
    let step = startIndex;
    const progress = (state: WorkflowProgress["state"]): WorkflowProgress => ({
      name: wf.name, step, total: wf.steps.length, state,
    });
    const finish = (state: RunOutcome) => {
      setOutcomes((prev) => ({ ...prev, [threadId]: state }));
      setWorkflowHistory((prev) => ({ ...prev, [threadId]: progress(state) }));
    };
    try {
      const result = await runWorkflowSteps(wf, startIndex, {
        shouldStop: () => stopRunRef.current,
        onStep: (nextStep) => {
          step = nextStep;
          setWorkflowProgress({ ...progress("running"), threadId });
        },
        runPrompt: (prompt) => sendTurn(prompt, thread),
      });
      step = result.step;
      if ("gate" in result) {
        if (!saveWorkflowCheckpoint(threadId, { workflowId: wf.id, nextStep: result.nextStep, kind: result.gate.kind })) {
          finish("failed");
        }
        return;
      }
      finish(result.state);
    } catch (error) {
      console.error("Workflow chain failed:", error);
      finish(stopRunRef.current ? "cancelled" : "failed");
    } finally {
      workflowRunningRef.current = false;
      setWorkflowProgress(null);
      setIsStopping(false);
    }
  };

  const cannotStartTurn = () => busy || workflowRunningRef.current || agentLoopRef.current.isBusy();

  const handleRunWorkflow = (wf: BotWorkflow) => {
    const model = workflowModel ?? selectedModel;
    if (cannotStartTurn() || !modelCanRunWorkflow(wf, model)) return;
    const thread = createThread(activeBot, model, wf.name);
    void runWorkflowChain(wf, thread, 0);
  };

  const resumeWorkflow = (event: { kind: "human_input"; text: string } | { kind: "approval" }) => {
    if (cannotStartTurn()) return;
    const thread = threadsRef.current.find((t) => t.id === activeThreadId);
    if (!thread) return;
    const pause = resumableWorkflow(thread);
    if (!pause || pause.gate.kind !== event.kind) return;
    const decision = event.kind === "approval"
      ? "Workflow decision: I approve the plan. Continue to the next step, keeping any tool review separate."
      : event.text.trim();
    // A human reply is evidence for the next prompt, not another agent turn.
    if (decision && saveWorkflowCheckpoint(thread.id, undefined, decision)) {
      void runWorkflowChain(pause.workflow, thread, pause.nextStep);
    }
  };

  const handleSendMessage = (text: string) => {
    if (cannotStartTurn() || !text.trim()) return;
    if (activeThread?.pendingWorkflow) {
      resumeWorkflow({ kind: "human_input", text });
      return;
    }
    stopRunRef.current = false;
    const title = text.slice(0, 45) + (text.length > 45 ? "…" : "");
    const thread = activeThread ?? createThread(activeBot, selectedModel, title);
    void sendTurn(text, thread);
  };

  const cancelPendingWorkflow = () => {
    if (cannotStartTurn()) return;
    const thread = threadsRef.current.find((t) => t.id === activeThreadId);
    if (!thread?.pendingWorkflow) return;
    const pause = resumableWorkflow(thread);
    const decision = pause?.gate.kind === "approval" ? "Workflow decision: I declined the plan and ended the workflow." : undefined;
    if (!saveWorkflowCheckpoint(thread.id, undefined, decision)) return;
    if (pause) {
      setWorkflowHistory((prev) => ({ ...prev, [thread.id]: {
        name: pause.workflow.name, step: pause.nextStep, total: pause.workflow.steps.length, state: "cancelled",
      } }));
    }
    setOutcomes((prev) => ({ ...prev, [thread.id]: "cancelled" }));
  };

  const handleApproveTool = (toolCallId: string) => {
    const resolver = approvalResolversRef.current.get(toolCallId);
    if (resolver) {
      resolver(true);
      approvalResolversRef.current.delete(toolCallId);
    }
  };

  const handleAlwaysAllowTool = async (toolCallId: string) => {
    for (const entry of currentTranscript) {
      const tc = entry.toolCalls?.find((t) => t.id === toolCallId);
      if (tc && tc.name === "execute_shell" && tc.arguments.command) {
        try {
          const command = tc.arguments.command as string;
          // Must mirror the agent loop's resolution: the run recorded the
          // resolved cwd on the tool call, so scope the grant to exactly
          // what was checked — otherwise the grant never matches again.
          const cwd = tc.arguments.cwd || systemInfo?.cwd || undefined;
          const grants = await TauriBridge.loadStandingGrants();
          const already = grants.some((g) =>
            typeof g === "string"
              ? g === command
              : g.command === command && (g.cwd ?? undefined) === cwd
          );
          if (!already) {
            // New grants are scoped to the workspace they were approved in.
            await TauriBridge.saveStandingGrants([...grants, { command, cwd }]);
          }
        } catch (e) {
          console.error("Failed to save standing grant:", e);
        }
        break;
      }
    }
    handleApproveTool(toolCallId);
  };

  const handleRejectTool = (toolCallId: string) => {
    const resolver = approvalResolversRef.current.get(toolCallId);
    if (resolver) {
      resolver(false);
      approvalResolversRef.current.delete(toolCallId);
    }
  };

  const handleSaveVault = async (updated: VaultConfig): Promise<boolean> => {
    try {
      const next = { ...updated };
      if (!isTauriEnvironment()) {
        delete next.anthropicApiKey;
        delete next.openaiApiKey;
        delete next.grokApiKey;
      }
      const saved = await TauriBridge.saveVaultConfig(JSON.stringify(next, null, 2));
      if (saved) setVault(next);
      return saved;
    } catch (e) {
      console.error("Failed to persist vault config:", e);
      return false;
    }
  };

  const handleUpdateBot = (updated: BotPersona) => {
    const updatedBots = bots.map((b) => (b.id === updated.id ? updated : b));
    setBots(updatedBots);
    setActiveBot((current) => current.id === updated.id ? updated : current);
  };

  const navigate = (target: WorkspaceView) => {
    if (busy && target !== view) return;
    if (target === "chats" && activeThread?.isRoom) setActiveThreadId(null);
    if (target === "rooms" && !activeThread?.isRoom) setActiveThreadId(null);
    setMobileRail(false);
    setInspectorOverlay(false);
    setView(target);
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
        setMobileRail(false);
        setInspectorOverlay(false);
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "n" &&
          !busy && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        handleNewThread();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  const exportChat = () => {
    if (!activeThread) return;
    const markdown = [`# ${activeThread.title || "Conversation"}`, ...currentTranscript
      .filter((entry) => (entry.role === "user" || entry.role === "assistant") && entry.content.trim())
      .map((entry) => `## ${entry.role === "user" ? "You" : bots.find((bot) => bot.id === entry.authorBotId)?.name ?? activeBot.name}\n\n${entry.content}`)].join("\n\n");
    const href = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = href;
    link.download = `${(activeThread.title || "conversation").replace(/[^\w-]+/g, "-").slice(0, 90)}.md`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  const starters = activeBot.suggestedPrompts?.length ? activeBot.suggestedPrompts : DEFAULT_BOTS[0].suggestedPrompts ?? [];
  const threadTitle = activeThread?.title || "A little help, a fresh start.";
  const dialogModel = view === "workflows" ? workflowModel ?? selectedModel : selectedModel;
  const choiceTitle = dialog === "agent" ? "A different way of thinking." : dialog === "model" ? "Choose your model." : dialog === "thread" ? "Conversation options" : "Keyboard shortcuts";
  const contextDescription = currentTranscript.length ? "Changing the agent or model starts a fork. The original conversation stays unchanged." : undefined;
  const newRoom = () => setIsRoomModalOpen(true);
  const chooseBot = (id: string) => { const bot = bots.find((item) => item.id === id); if (bot) handleSelectBot(bot); };

  return (
    <div className="warm-workspace">
      <div className="app-shell">
        <WorkspaceTitlebar workspace={workspace} browserPreview={!isTauriEnvironment()} auditRecordingFailed={auditRecordingFailed}
          auditUnavailable={busy && view !== "audit"} onAudit={() => navigate("audit")} onHelp={() => setDialog("help")} />
        <div className="main-layout">
          <WorkspaceSidebar view={view} onNavigate={navigate} onNew={handleNewThread} workspace={workspace} status={runStatus} pending={pending.length} busy={busy} />
          <main className={`surface ${inConversation && !openInspector ? "inspector-closed" : ""}`} aria-label="Workspace">
            {inConversation ? <>
              <ChatRail rooms={view === "rooms"} threads={threads} entries={transcripts} bots={bots} active={activeThreadId}
                busy={busy} mobile={mobileRail} onSelect={handleSelectThread} onNew={view === "rooms" ? newRoom : handleNewThread} onClose={() => setMobileRail(false)} />
              <section className="conversation" aria-label="Conversation">
                <header className="chat-header">
                  <Action icon={ArrowLeft} label="Show conversations" className="mobile-back" expanded={mobileRail} controls="chat-rail" onClick={() => { setMobileRail(!mobileRail); setInspectorOverlay(false); }} />
                  <div className="chat-heading">
                    <h1>{activeThread?.isRoom ? <Users className="icon" aria-hidden="true" /> : <Sparkles className="icon" aria-hidden="true" />}<span className="truncate" title={threadTitle}>{threadTitle}</span></h1>
                    <div className="header-tags">
                      {activeThread?.isRoom
                        ? <span className="tag purple"><Users className="icon" aria-hidden="true" />{roomMembers.length} agents</span>
                        : <button type="button" className="tag purple" onClick={() => setDialog("agent")} disabled={busy}><Bot className="icon" aria-hidden="true" />{activeBot.name}<ChevronDown className="icon" aria-hidden="true" /></button>}
                      <button type="button" className="tag" onClick={() => setDialog("model")} disabled={busy}>{selectedModel.name}<ChevronDown className="icon" aria-hidden="true" /></button>
                      <button type="button" className="tag" onClick={() => navigate("files")} disabled={busy}><Folder className="icon" aria-hidden="true" />{workspace}</button>
                    </div>
                    {!!roomMembers.length && <div className="room-members">{roomMembers.map((member) => <span key={member.id} className="room-member">@{member.slug}</span>)}</div>}
                  </div>
                  <div className="header-actions">
                    {activeThread && <Action icon={Download} label="Export conversation as Markdown" className="export-btn" onClick={exportChat} disabled={!currentTranscript.length || busy} />}
                    {activeThread && <Action icon={MoreHorizontal} label="Conversation options" onClick={() => setDialog("thread")} disabled={busy} />}
                    <Action icon={PanelRight} label="Toggle run details" className="inspect-toggle" expanded={openInspector} controls={openInspector ? "run-inspector" : undefined} onClick={toggleInspector} />
                  </div>
                </header>

                <div className="chat-content" ref={scrollContainerRef} onScroll={handleTranscriptScroll} aria-label="Conversation messages">
                  {!currentTranscript.length ? <div className="empty-state chat-welcome">
                    <AnyBotCharacter mood={welcomeMood} className="mascot" size={110} />
                    <h2>{activeThread?.isRoom ? threadTitle : activeBot.name}</h2>
                    <p>{activeThread?.isRoom ? `Mention up to three agents with @ and they’ll answer in order. Without a mention, ${roomMembers[0]?.name ?? "the primary agent"} responds.` : activeBot.description}</p>
                    {!activeThread?.isRoom && !activeThread?.pendingWorkflow && <div className="suggestions">{starters.map((item) => {
                      const needsTools = !!item.toolsRequired && !selectedModel.supportsTools;
                      return <button className="suggestion" type="button" key={item.title} disabled={needsTools || busy}
                        title={needsTools ? "Choose a tool-capable model to run this" : item.subtitle} onClick={() => void handleSendMessage(item.prompt)}>
                        <Sparkles className="icon" aria-hidden="true" />{item.title}{needsTools && <span className="suggestion-requirement">Requires tools</span>}
                      </button>;
                    })}</div>}
                  </div> : <>
                    {activeThread?.isRoom && <div className="room-info"><Users className="icon" aria-hidden="true" />Mention up to three agents with @ to ask for their responses in order.</div>}
                    {currentTranscript.map((entry, index) => <MessageItem key={entry.id} entry={entry}
                      bot={bots.find((item) => item.id === entry.authorBotId) ?? activeBot}
                      onApproveTool={handleApproveTool} onAlwaysAllowTool={handleAlwaysAllowTool} onRejectTool={handleRejectTool}
                      onRequestToolChanges={(id, feedback) => {
                        if (!pending.some((tool) => tool.id === id && tool.name === "write_file")) return;
                        const resolve = approvalResolversRef.current.get(id);
                        if (!resolve) return;
                        approvalResolversRef.current.delete(id);
                        resolve(false, feedback);
                      }}
                      onFork={activeThread && !busy ? () => forkThread(activeThread, activeBot, selectedModel, entry.id) : undefined}
                      isStreaming={isGenerating && !pending.length && entry.role === "assistant" && index === currentTranscript.length - 1} />)}
                    <div ref={transcriptEndRef} />
                  </>}
                </div>

                {workflowSaveError && workflowSaveError.threadId === activeThreadId && <div className="room-info workflow-pause" role="alert">{workflowSaveError.message}</div>}
                {activeThread?.pendingWorkflow && !busy && (
                  <div className="room-info workflow-pause">
                    <span className="grow" role="status">{pausedWorkflow?.gate.kind === "approval"
                      ? "Review the plan before continuing. Proposed file changes still need their own approval."
                      : pausedWorkflow ? "Workflow paused for your input. Reply here to continue."
                        : "This workflow can’t resume with its saved steps, agent, or model. End it to return to chat."}</span>
                    <div className="workflow-actions">
                      {pausedWorkflow?.gate.kind === "approval" && <button type="button" className="btn primary small" onClick={() => resumeWorkflow({ kind: "approval" })}>Approve plan &amp; continue</button>}
                      <button type="button" className="btn small" onClick={cancelPendingWorkflow}>{pausedWorkflow?.gate.kind === "approval" ? "Decline & end workflow" : "End workflow"}</button>
                    </div>
                  </div>
                )}
                {!isNearBottom && !!currentTranscript.length && <button type="button" className="btn small jump-latest" onClick={jumpToLatest}><ArrowDown className="icon sm" aria-hidden="true" />{pending.length ? "Review latest action" : "Jump to latest"}</button>}
                {(!activeThread?.pendingWorkflow || pausedWorkflow?.gate.kind === "human_input" || busy) && (
                  <Composer key={activeThreadId ?? "new"} onSendMessage={handleSendMessage} onStop={handleStop} isGenerating={busy} isStopping={isStopping}
                    isAwaitingApproval={pending.length > 0} selectedModel={selectedModel} onSelectModel={handleSelectModel}
                    mentionCandidates={activeThread?.isRoom ? roomMembers : undefined} botName={activeThread?.isRoom ? activeThread.title : activeBot.name} />
                )}
              </section>
              {openInspector && <Inspector key={activeThreadId ?? "new"} overlay={inspectorOverlay} status={runStatus} thread={activeThread} bot={activeBot} model={selectedModel}
                entries={currentTranscript} workspace={workspace} workflow={threadWorkflow} busy={busy}
                safeTools={vault.autoApproveSafeTools !== false && activeBot.autoApproveSafeTools} onAudit={() => navigate("audit")} onSettings={() => navigate("settings")} onClose={() => setInspectorOverlay(false)} />}
            </> : view === "settings" ? <SettingsModal embedded isOpen onClose={() => navigate("chats")} vault={vault} onSaveVault={handleSaveVault} />
              : <WorkspacePages page={view as Exclude<WorkspaceView, "chats" | "settings">} bots={bots} workflows={workflows} rooms={threads.filter((thread) => thread.isRoom)}
                cwd={systemInfo?.cwd ?? ""} homeDir={systemInfo?.homeDir} model={view === "workflows" ? workflowModel ?? selectedModel : selectedModel} activeBot={activeBot} busy={busy}
                auditRecordingFailed={auditRecordingFailed} onChooseModel={() => setDialog("model")} onNewRoom={newRoom} onSelectRoom={handleSelectThread}
                onSelectBot={chooseBot} onEditBot={(id) => setEditingBot(bots.find((bot) => bot.id === id) ?? null)} onCreateBot={handleCreateNewBot}
                onRunWorkflow={(id) => { const workflow = workflows.find((item) => item.id === id); if (workflow) void handleRunWorkflow(workflow); }} />}
          </main>
        </div>
      </div>

      {editingBot && <BotDrawer isOpen onClose={() => setEditingBot(null)} bot={editingBot} onUpdateBot={handleUpdateBot} />}
      <NewRoomModal isOpen={isRoomModalOpen} onClose={() => setIsRoomModalOpen(false)} bots={bots} onCreateRoom={handleCreateRoom} />
      {dialog && <WorkspaceDialog title={choiceTitle} description={dialog === "agent" || (dialog === "model" && view !== "workflows") ? contextDescription : undefined} onClose={() => setDialog(null)}>
        {dialog === "help" && <div className="shortcut-grid"><span>New chat</span><kbd>Ctrl / ⌘ + N</kbd><span>Send a message</span><kbd>Enter</kbd><span>Insert a line break</span><kbd>Shift + Enter</kbd><span>Close a dialog</span><kbd>Esc</kbd></div>}
        {dialog === "agent" && <div className="option-list">{bots.map((bot) => <button type="button" key={bot.id} className={`option-item ${activeBot.id === bot.id ? "selected" : ""}`} onClick={() => { chooseBot(bot.id); setDialog(null); }}>
          <span aria-hidden="true">{bot.avatar}</span><span className="grow"><strong>{bot.name}</strong><small>{bot.description}</small></span>{activeBot.id === bot.id && <span className="tag">Current</span>}
        </button>)}</div>}
        {dialog === "model" && <div className="option-list">{AVAILABLE_MODELS.map((model) => <button type="button" key={model.id} className={`option-item ${dialogModel.id === model.id ? "selected" : ""}`} onClick={() => {
          if (view === "workflows") setWorkflowModel(model);
          else handleSelectModel(model);
          setDialog(null);
        }}><span className="grow"><strong>{model.name}</strong><small>{isCliModel(model) ? "Local CLI" : model.provider}</small></span><span className="tag">{isCliModel(model) ? "CLI-managed" : model.supportsTools ? "Tools" : "Chat only"}</span>{dialogModel.id === model.id && <span className="tag">Current</span>}</button>)}</div>}
        {dialog === "thread" && activeThread && <div className="option-list">
          <form className="field thread-rename" onSubmit={(event) => {
            event.preventDefault();
            const title = String(new FormData(event.currentTarget).get("title") ?? "").trim();
            if (!title) return;
            updateThreads((prev) => prev.map((thread) => thread.id === activeThread.id ? { ...thread, title } : thread));
            setDialog(null);
          }}><label htmlFor="conversation-name">Conversation name</label><div className="flex gap-8"><input id="conversation-name" name="title" defaultValue={activeThread.title} maxLength={100} required /><button type="submit" className="btn small">Rename</button></div></form>
          <button type="button" className="option-item" onClick={() => { handleTogglePinThread(activeThread.id); setDialog(null); }}>{activeThread.isPinned ? "Unpin conversation" : "Pin conversation"}</button>
          <button type="button" className="option-item" onClick={() => { forkThread(activeThread, activeBot, selectedModel); setDialog(null); }}><GitFork className="icon" aria-hidden="true" />Continue in a new fork</button>
          <button type="button" className="option-item" onClick={exportChat} disabled={!currentTranscript.length}><Download className="icon" aria-hidden="true" />Export as Markdown</button>
          <button type="button" className="btn danger" onClick={() => { handleDeleteThread(activeThread.id); setDialog(null); }}>Delete conversation</button>
        </div>}
      </WorkspaceDialog>}
      <div role="status" aria-live="polite">
        {deletedChat && <div className="toast"><span>Deleted “{deletedChat.thread.title || "New chat"}”.</span><button type="button" className="btn small" onClick={handleUndoDelete}>Undo</button></div>}
      </div>
    </div>
  );
};
export default App;

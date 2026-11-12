import React, { useState, useEffect, useRef } from "react";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { MessageItem } from "./components/Chat/MessageItem";
import { Composer } from "./components/Composer/Composer";
import { BotDrawer } from "./components/BotDrawer/BotDrawer";
import { SettingsModal } from "./components/SettingsModal/SettingsModal";
import { BotLibraryModal } from "./components/BotLibraryModal/BotLibraryModal";
import { AnyBotCharacter, type TaviMood } from "./components/Tavi/AnyBotCharacter";
import { DEFAULT_BOTS } from "./data/defaultBots";
import { AVAILABLE_MODELS } from "./services/ai/models";
import { AgentLoop } from "./services/agent/agentLoop";
import { TauriBridge } from "./services/tauri/bridge";
import {
  BotPersona,
  Thread,
  TranscriptEntry,
  VaultConfig,
  AIModel,
} from "./types";
import { ChevronRight, ArrowDown, Eye } from "lucide-react";

/** Authoritative run status: readable text first, Tavi mood follows it. */
interface RunStatus {
  label: string;
  mood: TaviMood;
}

export const App: React.FC = () => {
  // State — v4: capability-flagged starter prompts; custom bots survive
  const [bots, setBots] = useState<BotPersona[]>(() => {
    try {
      const saved = localStorage.getItem("anybot_bots_v4");
      if (saved) return JSON.parse(saved);
      const older =
        localStorage.getItem("anybot_bots_v3") ||
        localStorage.getItem("anybot_bots_v2") ||
        localStorage.getItem("anybot_bots");
      if (older) {
        const oldBots: BotPersona[] = JSON.parse(older);
        const customOnly = oldBots.filter((b) => b.isCustom);
        return [...DEFAULT_BOTS, ...customOnly];
      }
    } catch (e) {
      console.error("Stored agents are malformed; loading defaults.", e);
    }
    return DEFAULT_BOTS;
  });

  const [activeBot, setActiveBot] = useState<BotPersona>(bots[0]);

  const [threads, setThreads] = useState<Thread[]>(() => {
    try {
      const saved = localStorage.getItem("anybot_threads");
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      console.error("Stored tasks are malformed; starting empty.", e);
      return [];
    }
  });

  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  const [transcripts, setTranscripts] = useState<Record<string, TranscriptEntry[]>>(() => {
    try {
      const saved = localStorage.getItem("anybot_transcripts");
      return saved ? JSON.parse(saved) : {};
    } catch (e) {
      console.error("Stored transcripts are malformed; starting empty.", e);
      return {};
    }
  });

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
  } | null>(null);

  const [isGenerating, setIsGenerating] = useState(false);
  // Honest stop: stays true from clicking Stop until the run has settled.
  const [isStopping, setIsStopping] = useState(false);
  const [isBotDrawerOpen, setIsBotDrawerOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isLibraryModalOpen, setIsLibraryModalOpen] = useState(false);

  // Brief verified-completion celebration (Tavi success, "Completed" label)
  const [celebrate, setCelebrate] = useState(false);
  const prevGeneratingRef = useRef(false);

  // Autoscroll only while the reader is near the bottom
  const [isNearBottom, setIsNearBottom] = useState(true);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Undo-able chat deletion: keep the removed thread for a grace period
  const [deletedChat, setDeletedChat] = useState<{
    thread: Thread;
    entries: TranscriptEntry[];
  } | null>(null);
  const undoTimerRef = useRef<number | undefined>(undefined);

  const approvalResolversRef = useRef<Map<string, (approved: boolean) => void>>(
    new Map()
  );

  const agentLoopRef = useRef<AgentLoop>(new AgentLoop());
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Stable mirror of transcripts for effects that must not re-fire per token
  const transcriptsRef = useRef(transcripts);
  transcriptsRef.current = transcripts;

  useEffect(() => {
    async function init() {
      try {
        const sys = await TauriBridge.getSystemInfo();
        setSystemInfo({
          os: sys.os,
          username: sys.username,
          cwd: sys.cwd,
        });

        const vaultJson = await TauriBridge.loadVaultConfig();
        if (vaultJson && vaultJson !== "{}") {
          const parsed = JSON.parse(vaultJson);
          setVault(parsed);
          if (parsed.selectedModel) {
            const found = AVAILABLE_MODELS.find((m) => m.id === parsed.selectedModel);
            if (found) setSelectedModel(found);
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
    localStorage.setItem("anybot_threads", JSON.stringify(threads));
  }, [threads]);

  // Streaming writes a lot: debounce so each token doesn't serialize the
  // whole history synchronously.
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem("anybot_transcripts", JSON.stringify(transcripts));
      } catch (e) {
        console.error("Failed to persist transcript:", e);
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [transcripts]);

  // Completion: one short verified-success celebration, then back to idle.
  useEffect(() => {
    const was = prevGeneratingRef.current;
    prevGeneratingRef.current = isGenerating;
    if (was && !isGenerating && !isStopping) {
      const last = transcriptsRef.current[activeThreadId ?? ""]?.slice(-1)[0];
      if (last?.role === "assistant" && !last.content.startsWith("**Error:**")) {
        setCelebrate(true);
        const t = window.setTimeout(() => setCelebrate(false), 1600);
        return () => window.clearTimeout(t);
      }
    }
  }, [isGenerating, isStopping, activeThreadId]);

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
  }, [transcripts, activeThreadId, isNearBottom]);

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

  const hasPendingWriteReview = currentTranscript.some((e) =>
    e.toolCalls?.some((tc) => tc.name === "write_file" && tc.status === "pending_approval")
  );
  const hasRunningTool = currentTranscript.some((e) =>
    e.toolCalls?.some((tc) => tc.status === "running")
  );
  const lastEntry = currentTranscript[currentTranscript.length - 1];
  const lastTurnFailed =
    lastEntry?.role === "assistant" && lastEntry.content.startsWith("**Error:**");

  const runStatus: RunStatus = (() => {
    if (isStopping) return { label: "Stopping…", mood: "working" };
    if (isGenerating) {
      if (hasPendingWriteReview) return { label: "Waiting for your review", mood: "approval" };
      if (hasRunningTool) return { label: "Working on your request", mood: "working" };
      return { label: "Working on your request", mood: "thinking" };
    }
    if (hasPendingWriteReview) return { label: "Waiting for your review", mood: "approval" };
    if (celebrate && !lastTurnFailed) return { label: "Completed", mood: "success" };
    if (lastTurnFailed) return { label: "Something needs attention", mood: "error" };
    return { label: "Ready when you are", mood: "idle" };
  })();

  // Welcome-screen Tavi: one wave on arrival, then settle.
  const [welcomeMood, setWelcomeMood] = useState<TaviMood>("wave");
  useEffect(() => {
    setWelcomeMood("wave");
    const t = window.setTimeout(() => setWelcomeMood("idle"), 1500);
    return () => window.clearTimeout(t);
  }, [activeThreadId]);

  // ---- Handlers ------------------------------------------------------------

  const handleNewThread = () => {
    const newThread: Thread = {
      id: `thread_${Date.now()}`,
      botId: activeBot.id,
      modelId: selectedModel.id,
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setThreads([newThread, ...threads]);
    setActiveThreadId(newThread.id);
    setTranscripts({ ...transcripts, [newThread.id]: [] });
  };

  const handleDeleteThread = (threadId: string) => {
    const thread = threads.find((t) => t.id === threadId);
    setThreads(threads.filter((t) => t.id !== threadId));
    const nextTranscripts = { ...transcripts };
    delete nextTranscripts[threadId];
    setTranscripts(nextTranscripts);
    if (activeThreadId === threadId) {
      setActiveThreadId(threads.find((t) => t.id !== threadId)?.id || null);
    }

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
    setThreads((prev) => [deletedChat.thread, ...prev]);
    setTranscripts((prev) => ({
      ...prev,
      [deletedChat.thread.id]: deletedChat.entries,
    }));
    setDeletedChat(null);
  };

  const handleTogglePinThread = (threadId: string) => {
    setThreads(
      threads.map((t) => (t.id === threadId ? { ...t, isPinned: !t.isPinned } : t))
    );
  };

  /** Opening a task restores ITS agent and model — history keeps its identity. */
  const handleSelectThread = (threadId: string) => {
    setActiveThreadId(threadId);
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) return;
    const threadBot = bots.find((b) => b.id === thread.botId);
    if (threadBot) setActiveBot(threadBot);
    const modelId = thread.modelId ?? threadBot?.defaultModel;
    const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
    if (model) setSelectedModel(model);
  };

  /** A task with history keeps its identity: picking another agent forks a
      NEW task instead of silently re-instructing the old conversation. */
  const handleSelectBot = (bot: BotPersona) => {
    const model = AVAILABLE_MODELS.find((m) => m.id === bot.defaultModel);
    const currentThread = threads.find((t) => t.id === activeThreadId);
    const hasHistory = !!currentThread && (transcripts[currentThread.id]?.length ?? 0) > 0;

    if (currentThread && hasHistory && currentThread.botId !== bot.id) {
      const fork: Thread = {
        id: `thread_${Date.now()}`,
        botId: bot.id,
        modelId: model?.id ?? selectedModel.id,
        title: "New chat",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setThreads((prev) => [fork, ...prev]);
      setActiveThreadId(fork.id);
      setTranscripts((prev) => ({ ...prev, [fork.id]: [] }));
    } else if (currentThread && !hasHistory) {
      // Empty task: retarget it to the chosen agent.
      setThreads((prev) =>
        prev.map((t) =>
          t.id === currentThread.id
            ? { ...t, botId: bot.id, modelId: model?.id ?? t.modelId }
            : t
        )
      );
    }

    setActiveBot(bot);
    if (model) setSelectedModel(model);
  };

  const handleCustomizeBot = (bot: BotPersona) => {
    setActiveBot(bot);
    setIsBotDrawerOpen(true);
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
    handleSelectBot(newCustomBot);
    setIsBotDrawerOpen(true);
  };

  const handleSendMessage = async (text: string) => {
    // Concurrency policy: one run at a time. Sending during an active or
    // settling run is refused instead of sharing its controller.
    if (agentLoopRef.current.isBusy()) return;

    let currentThreadId = activeThreadId;

    if (!currentThreadId) {
      const newThread: Thread = {
        id: `thread_${Date.now()}`,
        botId: activeBot.id,
        modelId: selectedModel.id,
        title: text.slice(0, 30) + (text.length > 30 ? "..." : ""),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setThreads([newThread, ...threads]);
      setActiveThreadId(newThread.id);
      currentThreadId = newThread.id;
    } else {
      const currentList = transcripts[currentThreadId] || [];
      if (currentList.length === 0) {
        setThreads(
          threads.map((t) =>
            t.id === currentThreadId
              ? { ...t, title: text.slice(0, 30) + (text.length > 30 ? "..." : "") }
              : t
          )
        );
      }
    }

    const userEntry: TranscriptEntry = {
      id: `user_${Date.now()}`,
      threadId: currentThreadId,
      role: "user",
      content: text,
      timestamp: Date.now(),
    };

    const threadHistory = [...(transcripts[currentThreadId] || []), userEntry];
    setTranscripts({ ...transcripts, [currentThreadId]: threadHistory });

    // The THREAD owns this run's context, not the global selection — history
    // is never continued under a different agent's instructions.
    const thread = threads.find((t) => t.id === currentThreadId);
    const threadBot =
      bots.find((b) => b.id === (thread?.botId ?? activeBot.id)) ?? activeBot;
    const threadModel =
      AVAILABLE_MODELS.find((m) => m.id === (thread?.modelId ?? threadBot.defaultModel)) ??
      selectedModel;

    setIsGenerating(true);
    setIsStopping(false);

    try {
      await agentLoopRef.current.runTurn(
        currentThreadId,
        threadHistory,
        threadBot,
        threadModel,
        vault,
        (updatedEntry) => {
          setTranscripts((prev) => {
            const list = prev[currentThreadId!] || [];
            const idx = list.findIndex((e) => e.id === updatedEntry.id);
            if (idx !== -1) {
              const nextList = [...list];
              nextList[idx] = updatedEntry;
              return { ...prev, [currentThreadId!]: nextList };
            }
            return prev;
          });
        },
        (newEntry) => {
          setTranscripts((prev) => {
            const list = prev[currentThreadId!] || [];
            return { ...prev, [currentThreadId!]: [...list, newEntry] };
          });
        },
        (toolCall, resolve) => {
          approvalResolversRef.current.set(toolCall.id, resolve);
        }
      );
    } finally {
      // Settle before accepting new input: Stop keeps control until here.
      setIsGenerating(false);
      setIsStopping(false);
    }
  };

  const handleStop = () => {
    if (agentLoopRef.current.abort()) {
      // The run stays busy until it settles; the composer flips back to Send
      // only after the awaited runTurn resolves.
      setIsStopping(true);
    }
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
          const cwd = tc.arguments.cwd || systemInfo?.cwd || undefined;
          const grants = await TauriBridge.loadStandingGrants();
          const already = grants.some((g) =>
            typeof g === "string" ? g === command : g.command === command
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
    setVault(updated);
    try {
      await TauriBridge.saveVaultConfig(JSON.stringify(updated, null, 2));
      return true;
    } catch (e) {
      console.error("Failed to persist vault config:", e);
      return false;
    }
  };

  const handleUpdateBot = (updated: BotPersona) => {
    const updatedBots = bots.map((b) => (b.id === updated.id ? updated : b));
    setBots(updatedBots);
    setActiveBot(updated);
  };

  // Starters respect the model's real capability: file/command tasks are
  // disabled on chat-only models instead of promising what can't run.
  const toolCapable = selectedModel.supportsTools;
  const starters = (activeBot.suggestedPrompts && activeBot.suggestedPrompts.length > 0
    ? activeBot.suggestedPrompts
    : DEFAULT_BOTS[0].suggestedPrompts!);

  return (
    <div className="flex h-screen w-screen bg-chrome text-primary font-sans overflow-hidden">
      {/* Left Sidebar */}
      <Sidebar
        bots={bots}
        activeBot={activeBot}
        onSelectBot={handleSelectBot}
        threads={threads}
        activeThreadId={activeThreadId}
        onSelectThread={handleSelectThread}
        onNewThread={handleNewThread}
        onDeleteThread={handleDeleteThread}
        onTogglePinThread={handleTogglePinThread}
        onOpenSettings={() => setIsSettingsModalOpen(true)}
        onOpenBotDrawer={() => setIsBotDrawerOpen(true)}
        onOpenBotLibrary={() => setIsLibraryModalOpen(true)}
        systemInfo={systemInfo}
      />

      {/* Main Chat Area */}
      <main className="relative flex-1 flex flex-col h-full min-w-0 bg-chrome">
        {/* Header — task identity + authoritative run status */}
        <header className="h-12 border-b border-stroke px-5 flex items-center justify-between shrink-0 bg-chrome">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-base select-none">{activeBot.avatar}</span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-primary truncate leading-tight">
                {activeBot.name}
              </h2>
              <p className="text-xxs text-quaternary truncate max-w-md leading-tight">
                {activeThread?.title && activeThread.title !== "New chat"
                  ? activeThread.title
                  : activeBot.description}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {/* Status: text label is authoritative; Tavi is supplementary */}
            <div
              className="flex items-center gap-2 px-2 py-1 rounded-lg bg-elevated border border-stroke"
              aria-live="polite"
              title={runStatus.label}
            >
              <span aria-hidden="true">
                <AnyBotCharacter mood={runStatus.mood} size={22} />
              </span>
              <span className="text-xxs font-medium text-secondary whitespace-nowrap">
                {runStatus.label}
              </span>
            </div>
            <button
              onClick={() => setIsBotDrawerOpen(true)}
              className="px-3 py-1.5 rounded-lg border border-stroke bg-elevated hover:bg-elevatedHover text-xs font-medium text-secondary hover:text-primary transition-colors"
            >
              Configure
            </button>
          </div>
        </header>

        {/* Transcript */}
        <div
          ref={scrollContainerRef}
          onScroll={handleTranscriptScroll}
          className="flex-1 overflow-y-auto relative"
        >
          {currentTranscript.length === 0 ? (
            /* Welcome / empty state — scrollable, centered when it fits */
            <div className="h-full overflow-y-auto">
              <div className="min-h-full flex flex-col items-center justify-center px-6 py-8 max-w-xl mx-auto select-none">
                <span aria-hidden="true" className="mb-1 shrink-0">
                  <AnyBotCharacter mood={welcomeMood} size={88} />
                </span>
                <h3 className="text-lg font-semibold text-primary mb-1">
                  {activeBot.name}
                </h3>
                <p className="text-xs text-quaternary leading-relaxed mb-5 text-center max-w-sm">
                  {activeBot.description}
                </p>

              <div className="grid grid-cols-1 gap-2 w-full">
                {starters.map((item, idx) => {
                  const needsTools = !!item.toolsRequired && !toolCapable;
                  return (
                    <button
                      key={idx}
                      onClick={() => !needsTools && handleSendMessage(item.prompt)}
                      disabled={needsTools}
                      title={
                        needsTools
                          ? "This task needs a tool-capable model — pick one above the message box."
                          : undefined
                      }
                      className={`px-3.5 py-2.5 rounded-xl border border-stroke bg-elevated text-left text-xs text-secondary transition-colors flex items-center gap-2.5 group ${
                        needsTools
                          ? "opacity-50 cursor-not-allowed"
                          : "hover:bg-elevatedHover"
                      }`}
                    >
                      <div
                        className={`w-6 h-6 rounded-lg bg-hover flex items-center justify-center shrink-0 font-mono font-bold text-xs ${
                          needsTools ? "text-quaternary" : "text-accent"
                        }`}
                        aria-hidden="true"
                      >
                        ⚡
                      </div>
                      <span className="min-w-0">
                        <span
                          className={`block font-medium truncate ${
                            needsTools ? "text-secondary" : "text-primary group-hover:text-accent"
                          } transition-colors`}
                        >
                          {item.title}
                          {item.toolsRequired && !toolCapable && (
                            <span className="ml-1.5 text-xxs px-1.5 py-px rounded bg-hover text-tertiary font-mono align-middle">
                              needs tools
                            </span>
                          )}
                        </span>
                        <span className="block text-xxs text-quaternary truncate">
                          {needsTools
                            ? "Switch to a tool-capable model to run this"
                            : item.subtitle}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>

                <button
                  onClick={() => setIsLibraryModalOpen(true)}
                  className="mt-4 text-xs text-accent hover:underline flex items-center gap-1 font-medium"
                >
                  <span>Browse all {bots.length} agents in library</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ) : (
            <div className="py-4 space-y-1">
              {currentTranscript.map((entry) => (
                <MessageItem
                  key={entry.id}
                  entry={entry}
                  bot={activeBot}
                  onApproveTool={handleApproveTool}
                  onAlwaysAllowTool={handleAlwaysAllowTool}
                  onRejectTool={handleRejectTool}
                />
              ))}
              <div ref={transcriptEndRef} />
            </div>
          )}
        </div>

        {/* Composer — hidden while a proposed change awaits review, so the
            decision gets full attention. Shell approvals keep it visible. */}
        {hasPendingWriteReview ? (
          <div className="px-6 pb-4 pt-1 bg-chrome">
            <div className="max-w-[min(760px,100%)] mx-auto flex items-center justify-between gap-3 px-4 py-3 rounded-2xl border border-stroke bg-elevated">
              <div className="flex items-center gap-2.5 min-w-0">
                <span aria-hidden="true">
                  <AnyBotCharacter mood="approval" size={28} />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-primary">
                    Waiting for your review
                  </p>
                  <p className="text-xxs text-quaternary truncate">
                    A proposed file change needs Apply or Decline before anything runs.
                  </p>
                </div>
              </div>
              <button
                onClick={jumpToLatest}
                className="px-3 py-1.5 rounded-lg border border-stroke bg-elevated hover:bg-elevatedHover text-xs font-medium text-secondary hover:text-primary transition-colors flex items-center gap-1.5 shrink-0"
              >
                <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                Review change
              </button>
            </div>
          </div>
        ) : (
          <Composer
            onSendMessage={handleSendMessage}
            onStop={handleStop}
            isGenerating={isGenerating}
            isStopping={isStopping}
            selectedModel={selectedModel}
            onSelectModel={setSelectedModel}
          />
        )}

        {/* Jump to latest — shown only when the reader scrolled up */}
        {!isNearBottom && !hasPendingWriteReview && (
          <button
            onClick={jumpToLatest}
            className="absolute bottom-28 right-6 z-40 px-3 py-1.5 rounded-full border border-stroke bg-elevated shadow-md text-xs font-medium text-secondary hover:text-primary hover:bg-elevatedHover transition-colors flex items-center gap-1.5"
          >
            <ArrowDown className="w-3.5 h-3.5" aria-hidden="true" />
            Jump to latest
          </button>
        )}
      </main>

      {/* Right Drawer */}
      <BotDrawer
        isOpen={isBotDrawerOpen}
        onClose={() => setIsBotDrawerOpen(false)}
        bot={activeBot}
        onUpdateBot={handleUpdateBot}
      />

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        vault={vault}
        onSaveVault={handleSaveVault}
      />

      {/* Bot Library Modal */}
      <BotLibraryModal
        isOpen={isLibraryModalOpen}
        onClose={() => setIsLibraryModalOpen(false)}
        bots={bots}
        activeBot={activeBot}
        onSelectBot={handleSelectBot}
        onCustomizeBot={handleCustomizeBot}
        onCreateNewBot={handleCreateNewBot}
      />

      {/* Undo delete toast */}
      <div
        role="status"
        aria-live="polite"
        className="fixed bottom-4 left-4 z-50"
      >
        {deletedChat && (
          <div className="flex items-center gap-3 pl-4 pr-2 py-2 rounded-xl bg-bubbleUser text-white shadow-lg">
            <span className="text-xs">
              Deleted “{deletedChat.thread.title || "New chat"}”.
            </span>
            <button
              onClick={handleUndoDelete}
              className="px-2.5 py-1 rounded-lg bg-white/15 hover:bg-white/25 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Undo
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
export default App;

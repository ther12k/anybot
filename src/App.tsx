import React, { useState, useEffect, useRef } from "react";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { MessageItem } from "./components/Chat/MessageItem";
import { Composer } from "./components/Composer/Composer";
import { BotDrawer } from "./components/BotDrawer/BotDrawer";
import { SettingsModal } from "./components/SettingsModal/SettingsModal";
import { BotLibraryModal } from "./components/BotLibraryModal/BotLibraryModal";
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
import { Sparkles, Terminal, FileCode, ShieldCheck, ChevronRight } from "lucide-react";

export const App: React.FC = () => {
  // State — v3 migration: load new rich popular bots, preserving custom bots
  const [bots, setBots] = useState<BotPersona[]>(() => {
    const saved = localStorage.getItem("anybot_bots_v3");
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {}
    }
    const oldSaved =
      localStorage.getItem("anybot_bots_v2") ||
      localStorage.getItem("anybot_bots");
    if (oldSaved) {
      try {
        const oldBots: BotPersona[] = JSON.parse(oldSaved);
        const customOnly = oldBots.filter((b) => b.isCustom);
        return [...DEFAULT_BOTS, ...customOnly];
      } catch {}
    }
    return DEFAULT_BOTS;
  });

  const [activeBot, setActiveBot] = useState<BotPersona>(bots[0]);

  const [threads, setThreads] = useState<Thread[]>(() => {
    const saved = localStorage.getItem("anybot_threads");
    return saved ? JSON.parse(saved) : [];
  });

  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  const [transcripts, setTranscripts] = useState<Record<string, TranscriptEntry[]>>(() => {
    const saved = localStorage.getItem("anybot_transcripts");
    return saved ? JSON.parse(saved) : {};
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
  const [isBotDrawerOpen, setIsBotDrawerOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isLibraryModalOpen, setIsLibraryModalOpen] = useState(false);

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
    localStorage.setItem("anybot_bots_v3", JSON.stringify(bots));
  }, [bots]);

  useEffect(() => {
    localStorage.setItem("anybot_threads", JSON.stringify(threads));
  }, [threads]);

  useEffect(() => {
    localStorage.setItem("anybot_transcripts", JSON.stringify(transcripts));
  }, [transcripts]);

  useEffect(() => {
    const prefersMotion = window.matchMedia(
      "(prefers-reduced-motion: no-preference)"
    ).matches;
    transcriptEndRef.current?.scrollIntoView({
      behavior: prefersMotion ? "smooth" : "auto",
    });
  }, [transcripts, activeThreadId]);

  // Handlers
  const handleNewThread = () => {
    const newThread: Thread = {
      id: `thread_${Date.now()}`,
      botId: activeBot.id,
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

  const handleSelectBot = (bot: BotPersona) => {
    setActiveBot(bot);
    const model = AVAILABLE_MODELS.find((m) => m.id === bot.defaultModel);
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
    setActiveBot(newCustomBot);
    setIsBotDrawerOpen(true);
  };

  const handleSendMessage = async (text: string) => {
    let currentThreadId = activeThreadId;

    if (!currentThreadId) {
      const newThread: Thread = {
        id: `thread_${Date.now()}`,
        botId: activeBot.id,
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

    setIsGenerating(true);

    await agentLoopRef.current.runTurn(
      currentThreadId,
      threadHistory,
      activeBot,
      selectedModel,
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

    setIsGenerating(false);
  };

  const handleStop = () => {
    agentLoopRef.current.abort();
    setIsGenerating(false);
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
          const grants = await TauriBridge.loadStandingGrants();
          if (!grants.includes(tc.arguments.command)) {
            await TauriBridge.saveStandingGrants([...grants, tc.arguments.command]);
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

  const currentTranscript = activeThreadId ? transcripts[activeThreadId] || [] : [];

  return (
    <div className="flex h-screen w-screen bg-chrome text-primary font-sans overflow-hidden">
      {/* Left Sidebar */}
      <Sidebar
        bots={bots}
        activeBot={activeBot}
        onSelectBot={handleSelectBot}
        threads={threads}
        activeThreadId={activeThreadId}
        onSelectThread={setActiveThreadId}
        onNewThread={handleNewThread}
        onDeleteThread={handleDeleteThread}
        onTogglePinThread={handleTogglePinThread}
        onOpenSettings={() => setIsSettingsModalOpen(true)}
        onOpenBotDrawer={() => setIsBotDrawerOpen(true)}
        onOpenBotLibrary={() => setIsLibraryModalOpen(true)}
        systemInfo={systemInfo}
      />

      {/* Main Chat Area */}
      <main className="flex-1 flex flex-col h-full min-w-0 bg-chrome">
        {/* Header */}
        <header className="h-12 border-b border-stroke px-5 flex items-center justify-between shrink-0 bg-chrome">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-base select-none">{activeBot.avatar}</span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-primary truncate leading-tight">
                {activeBot.name}
              </h2>
              <p className="text-xxs text-quaternary truncate max-w-md leading-tight">
                {activeBot.description}
              </p>
            </div>
          </div>

          <button
            onClick={() => setIsBotDrawerOpen(true)}
            className="px-3 py-1.5 rounded-lg border border-stroke bg-elevated hover:bg-elevatedHover text-xs font-medium text-secondary hover:text-primary transition-colors"
          >
            Configure
          </button>
        </header>

        {/* Transcript */}
        <div className="flex-1 overflow-y-auto">
          {currentTranscript.length === 0 ? (
            /* Welcome / empty state — centered like Grok */
            <div className="h-full flex flex-col items-center justify-center px-6 max-w-xl mx-auto select-none">
              <div className="w-12 h-12 rounded-full bg-bubbleUser flex items-center justify-center text-xl shadow-sm mb-3 select-none">
                {activeBot.avatar}
              </div>
              <h3 className="text-lg font-semibold text-primary mb-1">
                {activeBot.name}
              </h3>
              <p className="text-xs text-quaternary leading-relaxed mb-6 text-center">
                {activeBot.description}
              </p>

              <div className="grid grid-cols-1 gap-2 w-full">
                {(activeBot.suggestedPrompts && activeBot.suggestedPrompts.length > 0
                  ? activeBot.suggestedPrompts
                  : DEFAULT_BOTS[0].suggestedPrompts!
                ).map((item, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSendMessage(item.prompt)}
                    className="px-3.5 py-2.5 rounded-xl border border-stroke bg-elevated hover:bg-elevatedHover text-left text-xs text-secondary transition-colors flex items-center gap-2.5 group"
                  >
                    <div className="w-6 h-6 rounded-lg bg-hover flex items-center justify-center text-accent shrink-0 group-hover:scale-105 transition-transform font-mono font-bold text-xs">
                      ⚡
                    </div>
                    <span className="min-w-0">
                      <span className="block font-medium text-primary group-hover:text-accent transition-colors truncate">
                        {item.title}
                      </span>
                      <span className="block text-xxs text-quaternary truncate">
                        {item.subtitle}
                      </span>
                    </span>
                  </button>
                ))}
              </div>

              <button
                onClick={() => setIsLibraryModalOpen(true)}
                className="mt-4 text-xs text-accent hover:underline flex items-center gap-1 font-medium"
              >
                <span>Browse all {bots.length} agents in library</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
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

        {/* Composer */}
        <Composer
          onSendMessage={handleSendMessage}
          onStop={handleStop}
          isGenerating={isGenerating}
          selectedModel={selectedModel}
          onSelectModel={setSelectedModel}
        />
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

      {/* Bot Library & Marketplace Modal */}
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

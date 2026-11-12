import React, { useState } from "react";
import {
  Plus,
  Pin,
  Trash2,
  Settings,
  ChevronRight,
  Search,
} from "lucide-react";
import { Thread, BotPersona } from "../../types";

interface SidebarProps {
  bots: BotPersona[];
  activeBot: BotPersona;
  onSelectBot: (bot: BotPersona) => void;
  threads: Thread[];
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onNewThread: () => void;
  onDeleteThread: (threadId: string) => void;
  onTogglePinThread: (threadId: string) => void;
  onOpenSettings: () => void;
  onOpenBotDrawer: () => void;
  onOpenBotLibrary: () => void;
  systemInfo: { os: string; username: string; cwd: string } | null;
}

export const Sidebar: React.FC<SidebarProps> = ({
  bots,
  activeBot,
  onSelectBot,
  threads,
  activeThreadId,
  onSelectThread,
  onNewThread,
  onDeleteThread,
  onTogglePinThread,
  onOpenSettings,
  onOpenBotDrawer,
  onOpenBotLibrary,
  systemInfo,
}) => {
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const matches = (t: Thread) =>
    q === "" || t.title.toLowerCase().includes(q);
  const pinned = threads.filter((t) => t.isPinned && matches(t));
  const rest = threads.filter((t) => !t.isPinned && matches(t));
  const anyThreadMatches = pinned.length > 0 || rest.length > 0;

  const renderThread = (t: Thread) => {
    const isActive = activeThreadId === t.id;
    return (
      <li
        key={t.id}
        className={`group flex items-center gap-0.5 pr-1 pl-1 rounded-lg text-xs transition-colors ${
          isActive
            ? "bg-active"
            : "hover:bg-hover"
        }`}
      >
        <button
          onClick={() => onSelectThread(t.id)}
          aria-current={isActive ? "true" : undefined}
          className={`flex-1 min-w-0 text-left py-1.5 flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded ${
            isActive ? "text-primary font-medium" : "text-secondary"
          }`}
        >
          {t.isPinned && <Pin className="w-3 h-3 shrink-0 text-tertiary" />}
          <span className="truncate">{t.title || "New chat"}</span>
        </button>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
          <button
            onClick={() => onTogglePinThread(t.id)}
            className={`p-1 rounded hover:bg-active focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              t.isPinned ? "text-primary" : "text-tertiary hover:text-secondary"
            }`}
            title={t.isPinned ? "Unpin chat" : "Pin chat"}
            aria-label={t.isPinned ? `Unpin chat ${t.title}` : `Pin chat ${t.title}`}
          >
            <Pin className="w-3 h-3" aria-hidden="true" />
          </button>
          <button
            onClick={() => onDeleteThread(t.id)}
            className="p-1 rounded hover:bg-active text-tertiary hover:text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label={`Delete chat ${t.title}`}
          >
            <Trash2 className="w-3 h-3" aria-hidden="true" />
          </button>
        </div>
      </li>
    );
  };

  return (
    <aside className="w-60 h-full bg-sidebar border-r border-stroke flex flex-col select-none shrink-0">
      {/* Header — app identity + settings */}
      <div className="px-3 pt-3 pb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-bubbleUser flex items-center justify-center text-[11px] select-none" aria-hidden="true">
            ⚡
          </div>
          <span className="text-sm font-semibold text-primary tracking-tight">
            AnyBot
          </span>
        </div>
        <button
          id="anybot-settings-trigger"
          onClick={onOpenSettings}
          className="p-1.5 text-tertiary hover:text-primary hover:bg-hover rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Open settings and API keys"
        >
          <Settings className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      {/* New chat */}
      <div className="px-3 pb-2">
        <button
          onClick={onNewThread}
          className="w-full py-1.5 px-2.5 rounded-lg border border-stroke bg-elevated hover:bg-elevatedHover text-xs font-medium text-primary flex items-center gap-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Plus className="w-3.5 h-3.5" aria-hidden="true" />
          New chat
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="relative">
          <Search
            className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            className="w-full pl-8 pr-2.5 py-1.5 rounded-lg bg-hover text-primary text-xs placeholder:text-quaternary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent select-text"
          />
        </div>
      </div>

      {/* Active agent card */}
      <div className="px-3 pb-2">
        <div className="flex items-center justify-between px-1 mb-1">
          <span className="text-xxs font-semibold text-tertiary uppercase tracking-wide">
            Agent
          </span>
          <button
            onClick={onOpenBotLibrary}
            className="text-xxs text-accent hover:underline flex items-center gap-0.5"
            title="Browse all popular bots and templates"
          >
            <span>Explore</span>
          </button>
        </div>
        <button
          onClick={onOpenBotDrawer}
          className="w-full px-2.5 py-2 rounded-lg bg-elevated border border-stroke hover:bg-elevatedHover flex items-center justify-between text-left transition-colors group focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-sm select-none" aria-hidden="true">{activeBot.avatar}</span>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-primary truncate">
                {activeBot.name}
              </div>
              <div className="text-xxs text-quaternary truncate">
                {activeBot.slug}
              </div>
            </div>
          </div>
          <ChevronRight className="w-3.5 h-3.5 text-quaternary group-hover:text-secondary shrink-0" aria-hidden="true" />
        </button>

        {/* Bot avatar rail */}
        <div className="flex items-center gap-1 mt-1.5 px-0.5 overflow-x-auto" role="group" aria-label="Switch agent">
          {bots.map((b) => (
            <button
              key={b.id}
              onClick={() => onSelectBot(b)}
              aria-label={`Switch to ${b.name}`}
              aria-pressed={activeBot.id === b.id}
              className={`w-6 h-6 rounded-full text-[11px] flex items-center justify-center transition-all shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                activeBot.id === b.id
                  ? "bg-bubbleUser text-white"
                  : "bg-elevated border border-stroke text-secondary hover:bg-elevatedHover"
              }`}
            >
              <span aria-hidden="true">{b.avatar}</span>
            </button>
          ))}
          <button
            onClick={onOpenBotLibrary}
            aria-label="Browse full agent library"
            title="Browse all popular agents"
            className="w-6 h-6 rounded-full text-[11px] flex items-center justify-center transition-all shrink-0 bg-elevated border border-dashed border-stroke text-tertiary hover:text-primary hover:border-strokeStrong"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Threads */}
      <div className="flex-1 overflow-y-auto px-2 space-y-3">
        {pinned.length > 0 && (
          <div>
            <div className="px-2 py-1 text-xxs font-semibold text-tertiary uppercase tracking-wide">
              Pinned
            </div>
            <ul className="space-y-0.5 list-none">{pinned.map(renderThread)}</ul>
          </div>
        )}

        <div>
          <div className="px-2 py-1 text-xxs font-semibold text-tertiary uppercase tracking-wide">
            {q !== "" ? "Results" : "Recents"}
          </div>
          {rest.length === 0 && !anyThreadMatches ? (
            <div className="px-3 py-4 text-center text-xxs text-quaternary">
              {q !== ""
                ? `No chats matching “${query.trim()}”`
                : "No chats yet"}
            </div>
          ) : (
            <ul className="space-y-0.5 list-none">{rest.map(renderThread)}</ul>
          )}
        </div>
      </div>

      {/* System footer */}
      {systemInfo && (
        <div className="px-3 py-2.5 border-t border-stroke text-xxs font-mono text-quaternary flex items-center justify-between gap-2">
          <span className="truncate" title={systemInfo.cwd}>
            {systemInfo.cwd}
          </span>
          <span className="shrink-0">{systemInfo.username}@{systemInfo.os}</span>
        </div>
      )}
    </aside>
  );
};

import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  X,
  Search,
  Sparkles,
  Bot,
  Plus,
  Check,
  ChevronRight,
  Sliders,
} from "lucide-react";
import { BotPersona, BotCategory } from "../../types";

interface BotLibraryModalProps {
  isOpen: boolean;
  onClose: () => void;
  bots: BotPersona[];
  activeBot: BotPersona;
  onSelectBot: (bot: BotPersona) => void;
  onCustomizeBot: (bot: BotPersona) => void;
  onCreateNewBot: () => void;
}

const CATEGORIES: Array<{ id: BotCategory; label: string }> = [
  { id: "all", label: "All Agents" },
  { id: "general", label: "General" },
  { id: "code", label: "Code & Engineering" },
  { id: "research", label: "Research & Data" },
  { id: "productivity", label: "Productivity" },
  { id: "writing", label: "Writing & Docs" },
  { id: "fun", label: "Fun & Roast" },
];

export const BotLibraryModal: React.FC<BotLibraryModalProps> = ({
  isOpen,
  onClose,
  bots,
  activeBot,
  onSelectBot,
  onCustomizeBot,
  onCreateNewBot,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<BotCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (isOpen && !d.open) d.showModal();
    if (!isOpen && d.open) d.close();
  }, [isOpen]);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    const handleClose = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    d.addEventListener("close", handleClose);
    d.addEventListener("keydown", onKey);
    return () => {
      d.removeEventListener("close", handleClose);
      d.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const filteredBots = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return bots.filter((b) => {
      const matchesCat =
        selectedCategory === "all" || b.category === selectedCategory;
      if (!matchesCat) return false;
      if (!q) return true;
      const matchName = b.name.toLowerCase().includes(q);
      const matchDesc = b.description.toLowerCase().includes(q);
      const matchSlug = b.slug.toLowerCase().includes(q);
      const matchTags = b.tags?.some((t) => t.toLowerCase().includes(q)) ?? false;
      return matchName || matchDesc || matchSlug || matchTags;
    });
  }, [bots, selectedCategory, searchQuery]);

  if (!isOpen) return null;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="library-modal-title"
      className="w-[calc(100%-2rem)] max-w-4xl bg-chrome border border-stroke rounded-2xl shadow-2xl overflow-hidden"
    >
      <div className="flex flex-col h-[85vh] max-h-[750px] select-text">
        {/* Header */}
        <div className="px-6 h-14 border-b border-stroke flex items-center justify-between shrink-0 bg-chrome">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-full bg-bubbleUser flex items-center justify-center text-white text-xs" aria-hidden="true">
              <Bot className="w-4 h-4" />
            </div>
            <div>
              <h2 id="library-modal-title" className="text-sm font-semibold text-primary">
                Agent Library &amp; Marketplace
              </h2>
              <p className="text-xxs text-quaternary">
                Popular pre-configured agents inspired by Grok Bot
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                onClose();
                onCreateNewBot();
              }}
              className="px-3 py-1.5 rounded-lg border border-stroke bg-elevated hover:bg-elevatedHover text-xs font-medium text-primary flex items-center gap-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Plus className="w-3.5 h-3.5 text-accent" />
              <span>Create Custom Agent</span>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-tertiary hover:text-primary rounded-lg hover:bg-hover transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Close library"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Search & Category Filter Bar */}
        <div className="px-6 py-3 border-b border-stroke bg-sidebar space-y-2.5 shrink-0">
          <div className="relative">
            <Search
              className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-tertiary pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search agents by name, topic, or tag (#security, #docker, #fun)..."
              aria-label="Search agents"
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-elevated border border-stroke text-primary text-xs placeholder:text-quaternary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </div>

          {/* Category Tabs */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5" role="tablist" aria-label="Agent categories">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                role="tab"
                aria-selected={selectedCategory === cat.id}
                onClick={() => setSelectedCategory(cat.id)}
                className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  selectedCategory === cat.id
                    ? "bg-bubbleUser text-white shadow-sm"
                    : "bg-elevated border border-stroke text-secondary hover:text-primary hover:bg-elevatedHover"
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        {/* Bot Grid Cards */}
        <div className="flex-1 overflow-y-auto p-6">
          {filteredBots.length === 0 ? (
            <div className="h-48 flex flex-col items-center justify-center text-center">
              <Sparkles className="w-8 h-8 text-quaternary mb-2" />
              <p className="text-xs text-secondary font-medium">No agents found</p>
              <p className="text-xxs text-quaternary mt-0.5">
                Try a different search query or select &quot;All Agents&quot;.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {filteredBots.map((b) => {
                const isActive = activeBot.id === b.id;
                return (
                  <div
                    key={b.id}
                    className={`rounded-2xl border p-4 flex flex-col justify-between transition-all bg-elevated ${
                      isActive
                        ? "border-accent ring-1 ring-accent/30 shadow-md"
                        : "border-stroke hover:border-strokeStrong hover:shadow-sm"
                    }`}
                  >
                    <div>
                      {/* Top Row: Avatar, Name, Category */}
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="w-10 h-10 rounded-xl bg-hover border border-stroke flex items-center justify-center text-xl shrink-0 select-none shadow-xs">
                            {b.avatar}
                          </div>
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-primary truncate leading-tight flex items-center gap-1.5">
                              {b.name}
                              {b.isCustom && (
                                <span className="text-[10px] px-1.5 py-px rounded bg-hover text-tertiary font-mono">
                                  custom
                                </span>
                              )}
                            </h3>
                            <span className="text-xxs text-quaternary font-mono">
                              @{b.slug}
                            </span>
                          </div>
                        </div>

                        {b.category && (
                          <span className="text-xxs px-2 py-0.5 rounded-full bg-hover text-secondary font-medium shrink-0 capitalize">
                            {b.category}
                          </span>
                        )}
                      </div>

                      {/* Description */}
                      <p className="text-xs text-secondary leading-relaxed line-clamp-2 mb-3">
                        {b.description}
                      </p>

                      {/* Tags */}
                      {b.tags && b.tags.length > 0 && (
                        <div className="flex items-center gap-1.5 flex-wrap mb-3.5">
                          {b.tags.map((t) => (
                            <span
                              key={t}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-chrome border border-stroke text-quaternary font-mono"
                            >
                              #{t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Bottom Actions */}
                    <div className="pt-3 border-t border-stroke flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-xxs text-quaternary font-mono">
                        <span>Model:</span>
                        <span className="text-secondary font-semibold">
                          {b.defaultModel.split(":")[0]}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => {
                            onClose();
                            onCustomizeBot(b);
                          }}
                          className="p-1.5 text-quaternary hover:text-secondary hover:bg-hover rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                          title="Tune instructions and settings"
                          aria-label={`Configure ${b.name}`}
                        >
                          <Sliders className="w-3.5 h-3.5" />
                        </button>

                        {isActive ? (
                          <span className="px-3 py-1 rounded-lg bg-hover text-primary text-xs font-semibold flex items-center gap-1 select-none">
                            <Check className="w-3.5 h-3.5 text-success" />
                            Active
                          </span>
                        ) : (
                          <button
                            onClick={() => {
                              onSelectBot(b);
                              onClose();
                            }}
                            className="px-3 py-1 rounded-lg bg-bubbleUser hover:bg-[#333] text-white text-xs font-medium flex items-center gap-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                          >
                            <span>Chat</span>
                            <ChevronRight className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
};

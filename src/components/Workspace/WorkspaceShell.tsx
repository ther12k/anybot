import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bot, ChevronDown, CircleHelp, ClipboardList, Code2, Filter, Folder, Layers3,
  MessageSquare, Pin, Plus, Search, Settings2, Shield, SquarePen,
  Users, Workflow, X,
} from "lucide-react";
import { AnyBotCharacter, type TaviMood } from "../Tavi/AnyBotCharacter";
import type { AIModel, BotPersona, Thread, ToolCallItem, TranscriptEntry } from "../../types";

export type WorkspaceView = "chats" | "rooms" | "workflows" | "agents" | "files" | "audit" | "settings";
export type RunStatus = { label: string; mood: TaviMood };
export type WorkflowProgress = { name: string; step: number; total: number; finished?: boolean };

const sections = [
  ["chats", "Chats", MessageSquare], ["rooms", "Team Rooms", Users],
  ["workflows", "Workflows", Workflow], ["agents", "Agents", Bot],
  ["files", "Files", Folder], ["audit", "Audit log", ClipboardList],
  ["settings", "Settings", Settings2],
] as const;

export function Action({ icon: Icon, label, onClick, className = "", disabled, pressed, expanded, controls }: {
  icon: typeof Plus; label: string; onClick: () => void; className?: string;
  disabled?: boolean; pressed?: boolean; expanded?: boolean; controls?: string;
}) {
  return <button type="button" className={`icon-btn ${className}`} title={label} aria-label={label}
    aria-pressed={pressed} aria-expanded={expanded} aria-controls={controls} onClick={onClick} disabled={disabled}><Icon className="icon" aria-hidden="true" /></button>;
}

export function WorkspaceSidebar({ view, onNavigate, onNew, workspace, status, pending, busy }: {
  view: WorkspaceView; onNavigate: (view: WorkspaceView) => void; onNew: () => void;
  workspace: string; status: RunStatus; pending: number; busy: boolean;
}) {
  const note = status.mood === "approval" ? ["A little checkpoint.", "Your approval, then we’re off."]
    : status.mood === "working" || status.mood === "thinking" ? ["On it.", "One thoughtful step at a time."]
      : status.mood === "success" ? ["All wrapped up.", "A good moment to review."]
        : status.mood === "error" ? ["Let’s take a look.", "Check the run details."]
          : ["Room to think.", "What shall we make today?"];
  const renderNav = ([id, label, Icon]: typeof sections[number]) => (
    <button key={id} type="button" className={`nav-item ${view === id ? "active" : ""}`}
      aria-current={view === id ? "page" : undefined} aria-label={label} title={label}
      disabled={busy && view !== id} onClick={() => onNavigate(id)}>
      <Icon className="icon" aria-hidden="true" /><span>{label}</span>
      {id === view && pending > 0 && <span className="nav-count">{pending}</span>}
    </button>
  );
  return <aside className="sidebar">
    <button type="button" className="brand" aria-label="AnyBot home" disabled={busy} onClick={() => onNavigate("chats")}>
      <AnyBotCharacter size={42} className="brand-mark" /><span>AnyBot</span><small>BETA</small>
    </button>
    <button type="button" className="btn primary new-chat" aria-label="New chat" aria-keyshortcuts="Control+N Meta+N" title="New chat" onClick={onNew} disabled={busy}>
      <SquarePen className="icon" aria-hidden="true" /><span>New chat</span><kbd className="shortcut">{navigator.platform.startsWith("Mac") ? "⌘ N" : "Ctrl N"}</kbd>
    </button>
    <nav aria-label="Main navigation">
      <div className="nav-list">{sections.slice(0, 4).map(renderNav)}</div>
      <div className="nav-separator" />
      <div className="section-label">Workspace</div>
      <button type="button" className="workspace-btn" title={workspace} aria-label={`Open files: ${workspace}`} onClick={() => onNavigate("files")} disabled={busy}>
        <Folder className="icon" aria-hidden="true" /><span className="truncate">{workspace}</span><ChevronDown className="icon sm" aria-hidden="true" />
      </button>
      <div className="nav-list">{sections.slice(4).map(renderNav)}</div>
    </nav>
    <div className="sidebar-footer">
      <div className="tavi-note"><strong>{note[0]}</strong>{note[1]}</div>
      <div className="mascot-row"><AnyBotCharacter mood={status.mood} className="mascot" size={88} /></div>
      <div className="local-note">Chats stored on this device</div>
    </div>
  </aside>;
}

export function ChatRail({ rooms, threads, entries, bots, active, busy, mobile, onSelect, onNew, onClose }: {
  rooms: boolean; threads: Thread[]; entries: Record<string, TranscriptEntry[]>; bots: BotPersona[];
  active: string | null; busy: boolean; mobile: boolean;
  onSelect: (id: string) => void; onNew: () => void; onClose: () => void;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searching) searchRef.current?.focus(); }, [searching]);
  const candidates = threads.filter((thread) => Boolean(thread.isRoom) === rooms);
  const awaiting = (id: string) => entries[id]?.some((e) => e.toolCalls?.some((tc) => tc.status === "pending_approval"));
  const filtered = candidates.filter((thread) => (!pendingOnly || awaiting(thread.id)) &&
    (thread.title || "New chat").toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const groups = [["Pinned", filtered.filter((t) => t.isPinned)], ["Recent", filtered.filter((t) => !t.isPinned)]] as const;
  return <aside id="chat-rail" className={`chat-rail ${mobile ? "mobile-show" : ""}`} aria-label={rooms ? "Team rooms" : "Conversations"}>
    <div className="rail-head"><h2>{rooms ? "Team Rooms" : "Chats"}</h2><div className="rail-head-actions">
      <Action icon={Search} label="Search conversations" pressed={searching} onClick={() => { setSearching(!searching); setQuery(""); }} />
      <Action icon={Filter} label="Show only conversations waiting for approval" pressed={pendingOnly} className={pendingOnly ? "selected" : ""} onClick={() => setPendingOnly(!pendingOnly)} />
      <Action icon={Plus} label={rooms ? "Create team room" : "New chat"} onClick={onNew} disabled={busy} />
      <Action icon={X} className="mobile-back" label="Hide conversations" onClick={onClose} />
    </div></div>
    {searching && <div className="rail-search"><div className="search-input"><Search className="icon sm" aria-hidden="true" /><input ref={searchRef} type="search" aria-label="Find a conversation" placeholder="Find a conversation…" value={query} onChange={(e) => setQuery(e.target.value)} /></div></div>}
    <div className="rail-scroll">
      {!filtered.length && <p className="rail-group-label">{query || pendingOnly ? "No matching conversations" : rooms ? "No rooms yet" : "No chats yet"}</p>}
      {groups.map(([label, group]) => group.length > 0 && <section key={label} aria-label={label}>
        <div className="rail-group-label">{label}</div>
        {group.map((thread) => {
          const title = thread.title || "New chat";
          const Icon = rooms ? Users : thread.isPinned ? Pin : MessageSquare;
          return <button key={thread.id} type="button" className={`thread-item ${active === thread.id ? "active" : ""}`} title={title}
            aria-current={active === thread.id ? "true" : undefined} disabled={busy && active !== thread.id} onClick={() => onSelect(thread.id)}>
            <Icon className="icon" aria-hidden="true" /><span className="grow"><span className="thread-title">{title}</span>
              <span className="thread-meta">{awaiting(thread.id) ? "Waiting for approval" : rooms ? `${thread.participantBotIds?.length ?? 0} agents` : bots.find((b) => b.id === thread.botId)?.name || "Agent"}</span>
            </span>
          </button>;
        })}
      </section>)}
    </div>
    <div className="rail-bottom">{candidates.length} {rooms ? (candidates.length === 1 ? "room" : "rooms") : (candidates.length === 1 ? "conversation" : "conversations")}</div>
  </aside>;
}

function ContextRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="context-row"><span>{label}</span><span className="context-value">{children}</span></div>;
}

const toolStates: Record<ToolCallItem["status"], [string, string]> = {
  pending_approval: ["Needs approval", "amber"], running: ["Running", "purple"],
  completed: ["Completed", "green"], failed: ["Failed", "red"], rejected: ["Declined", "red"],
};

export function Inspector({ overlay, status, thread, bot, model, entries, workspace, workflow, busy, safeTools, onAudit, onSettings, onClose }: {
  overlay: boolean; status: RunStatus; thread: Thread | null; bot: BotPersona; model: AIModel;
  entries: TranscriptEntry[]; workspace: string; workflow?: WorkflowProgress; busy: boolean;
  safeTools: boolean; onAudit: () => void; onSettings: () => void; onClose: () => void;
}) {
  const [tab, setTab] = useState<"Run" | "Thread" | "Workflow">("Run");
  let lastPrompt = entries.length - 1;
  while (lastPrompt >= 0 && entries[lastPrompt].role !== "user") lastPrompt--;
  const tools = entries.slice(lastPrompt + 1).flatMap((entry) => entry.toolCalls ?? []);
  return <aside id="run-inspector" className={`inspector ${overlay ? "force-visible" : ""}`} aria-label="Conversation details">
    <div className="inspector-tabs" role="group" aria-label="Detail views">
      {(["Run", "Thread", "Workflow"] as const).map((name) => <button key={name} type="button" className={tab === name ? "active" : ""} aria-pressed={tab === name} onClick={() => setTab(name)}>{name}</button>)}
      <Action icon={X} label="Close run details" className="inspector-close" onClick={onClose} />
    </div>
    {tab === "Run" && <>
      <section className="inspector-card">
        <div className="run-status" role="status">{busy && status.mood !== "approval" ? <span className="spinner large" aria-hidden="true" /> : <span aria-hidden="true" className={`status-dot ${status.mood === "success" ? "green" : status.mood === "error" ? "red" : ""}`}>{status.mood === "success" ? "✓" : status.mood === "error" ? "!" : "·"}</span>}<strong>{status.label}</strong></div>
        <div className="run-sub">{thread ? "Latest turn in this conversation" : "No active conversation"}</div>
        <div className="run-visual"><p>{status.mood === "approval" ? "Review the proposed action in the conversation before it can run." : busy ? "You can stop the run from the composer." : "Tool activity appears below as it happens."}</p><AnyBotCharacter size={83} mood={status.mood} className="mascot" /></div>
        {!!tools.length && <div className="step-list">{tools.map((tool) => <div key={tool.id} className={`step ${tool.status === "completed" ? "done" : tool.status === "pending_approval" ? "current" : tool.status === "running" ? "running" : "failed"}`}><span className="step-icon" aria-hidden="true">{tool.status === "completed" ? "✓" : ""}</span><span className="grow">{tool.name}</span><span className={`tag ${toolStates[tool.status][1]}`}>{toolStates[tool.status][0]}</span></div>)}</div>}
      </section>
      <section className="inspector-card"><h3><Layers3 className="icon" aria-hidden="true" />Context</h3><div className="context-table">
        <ContextRow label="Workspace"><Folder className="icon" aria-hidden="true" />{workspace}</ContextRow>
        <ContextRow label={thread?.isRoom ? "Primary agent" : "Agent"}><Bot className="icon" aria-hidden="true" />{bot.name}</ContextRow>
        <ContextRow label="Model">{model.name}</ContextRow>
        <ContextRow label="Tools"><Code2 className="icon" aria-hidden="true" />{model.provider === "acp" ? "CLI-managed" : model.supportsTools ? "Available" : "Chat only"}</ContextRow>
      </div></section>
      <section className="inspector-card"><h3><ClipboardList className="icon" aria-hidden="true" />Audit<button className="text-link" type="button" onClick={onAudit} disabled={busy}>View all</button></h3><p className="small muted">Verify the protected audit log in the desktop app.</p></section>
      <section className="inspector-card"><h3><Shield className="icon" aria-hidden="true" />Permissions</h3><div className="policy-row">Safe tools<span className="tag neutral">{safeTools ? "Auto-approve" : "Ask first"}</span></div><div className="policy-row">File writes<span className="tag amber">Review required</span></div><div className="policy-row"><button className="text-link" type="button" onClick={onSettings} disabled={busy}>Open settings</button></div></section>
    </>}
    {tab === "Thread" && <section className="inspector-card"><h3><MessageSquare className="icon" aria-hidden="true" />About this {thread?.isRoom ? "room" : "thread"}</h3><p className="small muted">{thread?.title || "New conversation"}</p><div className="context-table">
      <ContextRow label="Messages">{entries.length}</ContextRow><ContextRow label="Workspace">{workspace}</ContextRow><ContextRow label="Agent">{bot.name}</ContextRow>{thread && <ContextRow label="Created">{new Date(thread.createdAt).toLocaleString()}</ContextRow>}
    </div></section>}
    {tab === "Workflow" && <section className="inspector-card"><h3><Workflow className="icon" aria-hidden="true" />Workflow</h3><p className="small muted">{workflow ? `${workflow.name} · Step ${workflow.step} of ${workflow.total}${workflow.finished ? " · Ended" : ""}` : "No workflow recorded for this conversation in this session."}</p></section>}
  </aside>;
}

export function WorkspaceDialog({ title, description, onClose, children }: { title: string; description?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return <dialog className="modal workspace-dialog" ref={ref} aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="modal-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}><X className="icon" aria-hidden="true" /></button></div>
    <div className="modal-body">{children}</div>
  </dialog>;
}

export function WorkspaceTitlebar({ workspace, browserPreview, onHelp }: { workspace: string; browserPreview: boolean; onHelp: () => void }) {
  return <div className="titlebar">
    <div className="titlebar-caption"><span>AnyBot</span><span aria-hidden="true"> / </span><span>{workspace}</span>
      {browserPreview && <span className="demo-pill" title="Native tools are simulated in the browser"><i aria-hidden="true" />Browser preview</span>}
    </div>
    <div className="titlebar-actions"><Action icon={CircleHelp} label="Keyboard shortcuts" onClick={onHelp} /></div>
  </div>;
}

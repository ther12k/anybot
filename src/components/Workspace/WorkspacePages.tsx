import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle, ArrowUpRight, BookOpen, Bot, CalendarDays, Code2, FileText,
  FlaskConical, Folder, GitBranch, Info, MessageCircle, PenLine, Play, Plus,
  Search, ShieldCheck, Sparkles, Users, Workflow, X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AVAILABLE_MODELS, isCliModel } from "../../services/ai/models";
import { isTauriEnvironment, TauriBridge, type AuditVerification } from "../../services/tauri/bridge";
import type { AIModel, BotCategory, BotPersona, BotWorkflow, Thread } from "../../types";
import type { WorkspaceResource } from "../../types/workspace";
import AnyBotCharacter from "../Tavi/AnyBotCharacter";
import { AuditReport, auditRequestError } from "./AuditReport";
import "./WorkspacePages.css";

export interface WorkspacePagesProps {
  page: "rooms" | "workflows" | "agents" | "files" | "audit";
  bots: BotPersona[];
  workflows: BotWorkflow[];
  rooms: Thread[];
  resources: WorkspaceResource[];
  model?: AIModel;
  activeBot?: BotPersona;
  busy?: boolean;
  canRunWorkflow: (workflow: BotWorkflow, model: AIModel) => boolean;
  onManageWorkspaces?: () => void;
  auditRecordingFailed: boolean;
  onChooseModel?: () => void;
  onNewRoom: () => void;
  onSelectRoom: (id: string) => void;
  onSelectBot: (id: string) => void;
  onEditBot: (id: string) => void;
  onCreateBot: () => void;
  onRunWorkflow: (id: string) => void;
}

const categories: { id: BotCategory; label: string; icon: LucideIcon; color: string }[] = [
  { id: "all", label: "All", icon: Bot, color: "" },
  { id: "general", label: "General", icon: Bot, color: "" },
  { id: "code", label: "Coding", icon: Code2, color: "blue" },
  { id: "research", label: "Research", icon: FlaskConical, color: "green" },
  { id: "writing", label: "Writing", icon: PenLine, color: "coral" },
  { id: "productivity", label: "Productivity", icon: CalendarDays, color: "gold" },
  { id: "fun", label: "Fun", icon: Sparkles, color: "" },
];

const categoryFor = (category?: BotCategory) =>
  categories.find(({ id }) => id === (category === "all" ? "general" : category)) ?? categories[1];

const workflowIcons: Record<string, LucideIcon> = {
  "wf-repo-health": GitBranch,
  "wf-code-review": Search,
  "wf-release-notes": PenLine,
  "wf-morning-brief": CalendarDays,
  "wf-readme-refresh": BookOpen,
  "wf-security-audit": ShieldCheck,
};

function Action({ children, icon: Icon, variant = "", onClick, disabled }: {
  children: ReactNode;
  icon: LucideIcon;
  variant?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" className={`btn ${variant}`} onClick={onClick} disabled={disabled}>
      <Icon className="icon" aria-hidden="true" />{children}
    </button>
  );
}

function Tag({ children, color = "", icon: Icon }: { children: ReactNode; color?: string; icon?: LucideIcon }) {
  return <span className={`tag ${color}`}>{Icon && <Icon className="icon" aria-hidden="true" />}{children}</span>;
}

function PageHeader({ eyebrow, title, description, action }: {
  eyebrow: string; title: string; description: string; action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="grow">
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}

function InfoBanner({ children, icon: Icon = Info, className = "" }: {
  children: ReactNode; icon?: LucideIcon; className?: string;
}) {
  return <div className={`info-banner ${className}`}><Icon className="icon" aria-hidden="true" /><span>{children}</span></div>;
}

function DetailDialog({ title, description, children, footer, onClose }: {
  title: string; description: string; children: ReactNode; footer?: ReactNode; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const modal = dialog.current;
    if (!modal) return;
    const previous = document.activeElement;
    modal.showModal();
    return () => {
      if (modal.open) modal.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return (
    <dialog ref={dialog} className="modal workspace-detail" aria-labelledby={titleId} onCancel={(event) => {
      event.preventDefault();
      onClose();
    }}>
      <header className="modal-head">
        <div><h2 id={titleId}>{title}</h2><p>{description}</p></div>
        <button type="button" className="icon-btn" aria-label="Close details" onClick={onClose}>
          <X className="icon" aria-hidden="true" />
        </button>
      </header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-footer">{footer}</footer>}
    </dialog>
  );
}

function RoomsPage({ rooms, onNewRoom, onSelectRoom }: WorkspacePagesProps) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);
  const visible = [...rooms].sort((a, b) => b.updatedAt - a.updatedAt)
    .filter(({ title }) => title.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <section className="workspace-rooms" aria-labelledby="workspace-rooms-title">
      <aside className="chat-rail" aria-label="Room list">
        <div className="rail-head">
          <h1 id="workspace-rooms-title">Team Rooms</h1>
          <div className="rail-head-actions">
            {rooms.length > 0 && <button type="button" className="icon-btn" aria-label="Search team rooms"
              aria-expanded={searchOpen} onClick={() => { if (searchOpen) setQuery(""); setSearchOpen(!searchOpen); }}>
              <Search className="icon" aria-hidden="true" />
            </button>}
            <button type="button" className="icon-btn" aria-label="Create team room" onClick={onNewRoom}>
              <Plus className="icon" aria-hidden="true" />
            </button>
          </div>
        </div>
        {searchOpen && <div className="rail-search"><div className="search-input">
          <Search className="icon sm" aria-hidden="true" />
          <input ref={searchRef} type="search" aria-label="Find a room" placeholder="Find a room…" value={query}
            onChange={(event) => setQuery(event.target.value)} />
        </div></div>}
        <div className="rail-scroll">
          {visible.length > 0 && <div className="rail-group-label">Your rooms</div>}
          {visible.map((room) => {
            const memberCount = new Set([room.botId, ...(room.participantBotIds ?? [])]).size;
            return (
              <button type="button" className="thread-item" key={room.id} onClick={() => onSelectRoom(room.id)} title={room.title}>
                <Users className="icon" aria-hidden="true" />
                <div className="grow">
                  <div className="thread-title">{room.title}</div>
                  <div className="thread-meta">{memberCount} {memberCount === 1 ? "agent" : "agents"}</div>
                </div>
              </button>
            );
          })}
          {visible.length === 0 && <p className="rail-group-label" role="status">{rooms.length ? "No matching rooms." : "No rooms here yet."}</p>}
        </div>
        <div className="rail-bottom"><ShieldCheck className="icon sm" aria-hidden="true" /> One human. A few good agents.</div>
      </aside>
      <div className="conversation">
        <div className="empty-state">
          <AnyBotCharacter size={115} />
          <h2>A few good minds, together.</h2>
          <p>{rooms.length ? "Pick a room to continue, or bring a new group of agents together." : "Start a shared conversation with a few agents. Mention someone for their perspective, and keep the final say."}</p>
          <Action icon={Plus} variant="primary" onClick={onNewRoom}>Create a room</Action>
        </div>
      </div>
    </section>
  );
}

function WorkflowsPage({ workflows, activeBot, model, busy, canRunWorkflow, onChooseModel, onRunWorkflow }: WorkspacePagesProps) {
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = workflows.find(({ id }) => id === detailId);
  const cannotRun = (workflow: BotWorkflow) => !model || busy || !canRunWorkflow(workflow, model);
  const run = (workflow: BotWorkflow) => {
    if (cannotRun(workflow)) return;
    setDetailId(null);
    onRunWorkflow(workflow.id);
  };
  const capability = (workflow: BotWorkflow) => workflow.toolsRequired
    ? <Tag>Requires AnyBot tools</Tag> : <Tag color="green">Chat compatible</Tag>;

  return (
    <section className="page workspace-secondary">
      <PageHeader eyebrow="A little less repetition" title="Good work, on repeat."
        description="Thoughtful task chains. One starting point. You stay in the loop."
        action={onChooseModel && <Action icon={Sparkles} onClick={onChooseModel} disabled={busy}>Choose model</Action>} />
      <div className="page-body">
        <div className="page-toolbar">
          <div className="flex gap-8 workspace-tag-group">
            <Tag color="purple" icon={Sparkles}>{model?.name ?? "No model selected"}</Tag>
            <Tag icon={Workflow}>{workflows.length} {workflows.length === 1 ? "workflow" : "workflows"}</Tag>
          </div>
          <span className="small muted workspace-toolbar-note">Every step waits for the last.</span>
        </div>
        <div className="card-grid">
          {workflows.map((workflow) => {
            const category = categoryFor(workflow.category);
            const Icon = workflowIcons[workflow.id] ?? Workflow;
            return (
              <article className="feature-card" key={workflow.id}>
                <div className={`card-icon ${category.color}`}><Icon className="icon" aria-hidden="true" /></div>
                <h2>{workflow.name}</h2>
                <p>{workflow.description}</p>
                <div className="card-tags">
                  <Tag>{workflow.steps.length} {workflow.steps.length === 1 ? "step" : "steps"}</Tag>
                  {activeBot && <Tag>{activeBot.name}</Tag>}
                  {capability(workflow)}
                </div>
                <div className="card-bottom">
                  <button type="button" className="text-link" onClick={() => setDetailId(workflow.id)} aria-label={`View steps for ${workflow.name}`}>
                    View steps <ArrowUpRight className="icon sm" aria-hidden="true" />
                  </button>
                  <Action icon={Play} variant="primary small" onClick={() => run(workflow)} disabled={cannotRun(workflow)}>Run workflow</Action>
                </div>
              </article>
            );
          })}
        </div>
        {!workflows.length && <div className="empty-state"><h2>No workflows yet.</h2><p>Available workflows will appear here.</p></div>}
        <InfoBanner icon={model?.supportsTools && !isCliModel(model) ? ShieldCheck : Info} className="workspace-after-content">
          {busy ? "Wait for the current run to finish before starting another workflow."
            : !model ? "Choose a model before starting a workflow."
            : isCliModel(model) ? "Choose an API or Ollama model for workspace workflows."
            : !activeBot ? "Install an agent in this workspace before running a workflow."
            : !model.supportsTools ? "Your selected model is chat-only. Workflows that need tools are disabled."
            : "Workflows use the current agent and model. Workflows that need unavailable tools are disabled."}
        </InfoBanner>
        <div className="section-heading"><h2>Recent runs</h2></div>
        <InfoBanner>Workflow history is not saved separately. Open Chats to review the conversation where a workflow ran.</InfoBanner>
      </div>
      {detail && <DetailDialog title={detail.name} description={detail.description} onClose={() => setDetailId(null)} footer={
        <Action icon={Play} variant="primary" disabled={cannotRun(detail)} onClick={() => run(detail)}>Run workflow</Action>
      }>
        <div className="flex gap-8 workspace-tag-group">{activeBot && <Tag color="purple">{activeBot.name}</Tag>}{capability(detail)}</div>
        <ol className="workspace-steps">
          {detail.steps.map((step, index) => <li className="workflow-detail-step" key={index}>
            <span className="workflow-num" aria-hidden="true">{index + 1}</span>
            <strong>{typeof step === "string" ? step : step.kind === "approval"
              ? "Your decision — approve the plan to continue or decline to end the workflow."
              : "Your reply — the workflow waits here until you respond."}</strong>
          </li>)}
        </ol>
        <p className="caption-note">A failed step stops the workflow. Checkpoints wait for a reply or decision before the next step is sent.</p>
      </DetailDialog>}
    </section>
  );
}

function AgentsPage({ bots, onSelectBot, onEditBot, onCreateBot }: WorkspacePagesProps) {
  const [category, setCategory] = useState<BotCategory>("all");
  const [query, setQuery] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = bots.find(({ id }) => id === detailId);
  const term = query.trim().toLowerCase();
  const visible = bots.filter((bot) => (category === "all" || categoryFor(bot.category).id === category) &&
    [bot.name, bot.slug, bot.description, ...(bot.tags ?? [])].some((value) => value.toLowerCase().includes(term)));
  const modelName = (bot: BotPersona) => AVAILABLE_MODELS.find(({ id }) => id === bot.defaultModel)?.name ?? bot.defaultModel;

  return (
    <section className="page workspace-secondary">
      <PageHeader eyebrow="Different minds. Shared possibility." title="Find your kind of help."
        description="A thoughtful cast of specialists, ready for your next question or project."
        action={<Action icon={Plus} variant="primary" onClick={onCreateBot}>Create an agent</Action>} />
      <div className="page-body">
        <div className="page-toolbar">
          <div className="filter-tabs" role="group" aria-label="Filter agents by category">
            {categories.map(({ id, label }) => <button type="button" key={id} aria-pressed={category === id}
              className={category === id ? "active" : ""} onClick={() => setCategory(id)}>{label}</button>)}
          </div>
          <div className="search-input">
            <Search className="icon sm" aria-hidden="true" />
            <input type="search" aria-label="Search agents" placeholder="Find an agent…" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
        </div>
        <div className="card-grid">
          {visible.map((bot) => {
            const { icon: Icon, label, color } = categoryFor(bot.category);
            return (
              <article className="feature-card" key={bot.id}>
                <div className="flex between">
                  <div className={`card-icon ${color}`}><Icon className="icon" aria-hidden="true" /></div>
                  {bot.isCustom && <Tag color="purple">Custom</Tag>}
                </div>
                <h2>{bot.name}</h2>
                <p>{bot.description}</p>
                <div className="card-tags"><Tag>{label}</Tag>{modelName(bot) && <Tag>{modelName(bot)}</Tag>}</div>
                <div className="card-bottom">
                  <button type="button" className="text-link" aria-label={`Meet ${bot.name}`} onClick={() => setDetailId(bot.id)}>
                    Meet {bot.name.trim().split(/\s+/)[0]} <ArrowUpRight className="icon sm" aria-hidden="true" />
                  </button>
                  <Action icon={MessageCircle} variant="small" onClick={() => onSelectBot(bot.id)}>Start a chat</Action>
                </div>
              </article>
            );
          })}
        </div>
        {visible.length === 0 && <div className="empty-state" role="status">
          <h2>{bots.length ? "No agents found." : "No agents yet."}</h2>
          <p>{bots.length ? "Try a different name or category." : "Create an agent to start a conversation."}</p>
        </div>}
      </div>
      {detail && <DetailDialog title={detail.name} description={detail.description} onClose={() => setDetailId(null)} footer={<>
        <Action icon={PenLine} onClick={() => { setDetailId(null); onEditBot(detail.id); }}>Edit agent</Action>
        <Action icon={MessageCircle} variant="primary" onClick={() => { setDetailId(null); onSelectBot(detail.id); }}>Start a chat</Action>
      </>}>
        <div className="flex gap-8 workspace-tag-group"><Tag color="purple">{categoryFor(detail.category).label}</Tag>{modelName(detail) && <Tag>{modelName(detail)}</Tag>}</div>
        <div className="modal-label">System prompt</div>
        <div className="audit-detail workspace-prompt">{detail.systemPrompt || "No system prompt configured."}</div>
        {!!detail.suggestedPrompts?.length && <>
          <div className="modal-label">Try asking</div>
          <ul className="option-list">
            {detail.suggestedPrompts.map((suggestion, index) => <li className="option-item" key={index}>
              <MessageCircle className="icon" aria-hidden="true" />
              <div><strong>{suggestion.title}</strong><small>{suggestion.subtitle}</small></div>
            </li>)}
          </ul>
        </>}
      </DetailDialog>}
    </section>
  );
}

type FileEntry = Awaited<ReturnType<typeof TauriBridge.listDirEntries>>[number];
type FilePreview = Awaited<ReturnType<typeof TauriBridge.readFileContent>>;
type LoadState<T> = { status: "idle" | "loading" | "error" } | { status: "ready"; data: T };

const MAX_FILE_SIZE = 256 * 1024;
const MAX_FILE_LINES = 400;
const normalizePath = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
const protectedNames = /^(?:audit\.jsonl|config\.json|policy\.json|standing-grants\.json|workspaces\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$|(?:^|[._-])(?:credentials?|secrets?|tokens?|passwords?|private[-_]?keys?)(?:[._-]|$)|\.(?:pem|key|pfx|p12|jks|keystore)$/i;

function isVisibleFile(root: string, entry: FileEntry) {
  return entry.is_file && !entry.is_dir && !entry.name.startsWith(".") && !/[\/\\:]/.test(entry.name) &&
    !protectedNames.test(entry.name) && normalizePath(entry.path) === `${root}/${entry.name}`;
}

function WorkspaceFiles({ resources, onManageWorkspaces }: Pick<WorkspacePagesProps, "resources" | "onManageWorkspaces">) {
  const [folderId, setFolderId] = useState("");
  const pickerId = useId();
  const folder = resources.find((item) => item.id === folderId) ?? resources[0];
  return <FilesPage key={folder?.id ?? "none"} folder={folder?.path} onManageWorkspaces={onManageWorkspaces} picker={resources.length > 0 && (
    <div className="field workspace-before-content">
      <label htmlFor={pickerId}>Workspace folder</label>
      <select id={pickerId} value={folder?.id} onChange={(event) => setFolderId(event.target.value)}>
        {resources.map((item) => <option key={item.id} value={item.id}>{item.path}</option>)}
      </select>
    </div>
  )} />;
}

function FilesPage({ folder, picker, onManageWorkspaces }: { folder?: string; picker: ReactNode; onManageWorkspaces?: () => void }) {
  const root = folder ? normalizePath(folder) : null;
  const canRead = isTauriEnvironment() && !!folder;
  const workspace = root?.split("/").pop() || root || "Workspace";
  const [list, setList] = useState<LoadState<FileEntry[]>>({ status: "idle" });
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [preview, setPreview] = useState<LoadState<FilePreview>>({ status: "idle" });
  const [revision, refresh] = useState(0);

  useEffect(() => {
    if (!canRead || root === null || !folder) return;
    let current = true;
    setList({ status: "loading" });
    // Do not start an audited native read for a superseded render.
    queueMicrotask(async () => {
      if (!current) return;
      try {
        const entries = await TauriBridge.listDirEntries(folder);
        if (current) setList({ status: "ready", data: entries.filter((entry) => isVisibleFile(root, entry)) });
      } catch {
        if (current) setList({ status: "error" });
      }
    });
    return () => { current = false; };
  }, [canRead, folder, root, revision]);

  useEffect(() => {
    if (!canRead || root === null || !selected || !isVisibleFile(root, selected) || selected.size > MAX_FILE_SIZE) return;
    let current = true;
    TauriBridge.readFileContent(selected.path, MAX_FILE_LINES).then(
      (data) => { if (current) setPreview({ status: "ready", data }); },
      () => { if (current) setPreview({ status: "error" }); },
    );
    return () => { current = false; };
  }, [canRead, root, selected]);

  return (
    <section className="page workspace-secondary">
      <PageHeader eyebrow="Your project, in context" title="A place for the details."
        description="Preview text files in folders granted to this workspace."
        action={onManageWorkspaces && <Action icon={Folder} onClick={onManageWorkspaces}>Manage folders</Action>} />
      <div className="page-body">
        <InfoBanner icon={Folder} className="workspace-before-content">
          {!isTauriEnvironment() ? "File previews are available in the AnyBot desktop app."
            : !folder ? "Add a folder grant to preview files in this workspace."
            : "Only files at the top of the selected folder are listed. Hidden and common credential files are omitted."}
        </InfoBanner>
        {picker}
        <div className="files-layout">
          <aside className="file-tree" aria-label="Workspace files">
            <div className="file-tree-label flex gap-6"><Folder className="icon sm" aria-hidden="true" /><span className="truncate" title={root ?? undefined}>{workspace}</span></div>
            {canRead && (list.status === "idle" || list.status === "loading") && <p className="workspace-file-note" role="status">Loading files…</p>}
            {list.status === "error" && <div className="workspace-file-note">
              <p role="alert">Could not list workspace files.</p>
              <button type="button" className="text-link" onClick={() => refresh((value) => value + 1)}>Try again</button>
            </div>}
            {list.status === "ready" && list.data.length === 0 && <p className="workspace-file-note" role="status">No files available to preview.</p>}
            {list.status === "ready" && list.data.map((entry) => (
              <button type="button" key={entry.path} className={`file-item${entry.path === selected?.path ? " active" : ""}`}
                aria-pressed={entry.path === selected?.path} title={entry.name} onClick={() => {
                  if (entry.path === selected?.path && preview.status !== "error") return;
                  setPreview({ status: entry.size > MAX_FILE_SIZE ? "idle" : "loading" });
                  setSelected({ ...entry });
                }}>
                <FileText className="icon" aria-hidden="true" /><span className="truncate">{entry.name}</span>
              </button>
            ))}
          </aside>
          <section className="file-editor" aria-label="File preview">
            <div className="file-editor-head">
              <FileText className="icon sm" aria-hidden="true" /><span className="truncate" title={selected?.name}>{selected?.name ?? "File preview"}</span>
              {selected && <Tag>Read-only</Tag>}
            </div>
            {!selected && <p className="file-source">{canRead ? "Select a file to preview it." : "No file preview available."}</p>}
            {selected && selected.size > MAX_FILE_SIZE && <p className="file-source">This file exceeds the 256 KB preview limit.</p>}
            {preview.status === "loading" && <p className="file-source" role="status">Loading preview…</p>}
            {preview.status === "error" && <p className="file-source" role="alert">Could not preview this file. It may not be readable text. Select it again to retry.</p>}
            {preview.status === "ready" && <>
              {preview.data.size_bytes > MAX_FILE_SIZE ? <p className="file-source">This file exceeds the 256 KB preview limit.</p>
                : preview.data.content ? <pre className="file-source" tabIndex={0} aria-label="File contents">{preview.data.content}</pre>
                : <p className="file-source">This file is empty.</p>}
              {preview.data.size_bytes <= MAX_FILE_SIZE && preview.data.total_lines > MAX_FILE_LINES &&
                <p className="caption-note workspace-file-note">Showing the first {MAX_FILE_LINES} of {preview.data.total_lines} lines.</p>}
            </>}
          </section>
        </div>
        <p className="caption-note">Previews are read-only and are not sent to an agent.</p>
      </div>
    </section>
  );
}

function AuditPage({ recordingFailed }: { recordingFailed: boolean }) {
  const desktop = isTauriEnvironment();
  const [report, setReport] = useState<LoadState<AuditVerification>>({ status: "idle" });
  const [explanation, setExplanation] = useState(false);
  const verify = async () => {
    if (!desktop || report.status === "loading") return;
    setReport({ status: "loading" });
    try {
      setReport({ status: "ready", data: await TauriBridge.verifyAuditLog() });
    } catch {
      setReport({ status: "error" });
    }
  };

  return (
    <section className="page workspace-secondary">
      <PageHeader eyebrow="Local activity" title="Audit log"
        description="Check the local hash chain and review recent recorded outcomes."
        action={<Action icon={ShieldCheck} variant="primary" onClick={verify} disabled={!desktop || report.status === "loading"}>
          {report.status === "loading" ? "Verifying…" : "Verify chain"}
        </Action>} />
      <div className="page-body">
        {recordingFailed && <div className="audit-result recording-warning">
          <AlertTriangle className="icon lg" aria-hidden="true" /><div><h2>Some audit activity may be missing.</h2>
            <p>At least one entry could not be saved since AnyBot started. Actions that already ran were not undone. Check that AnyBot can write to its local audit storage.</p></div>
        </div>}
        {!desktop && <InfoBanner>Audit verification is available in the desktop app.</InfoBanner>}
        {desktop && report.status === "idle" && <p className="small muted">Verify the chain to see the result and recent activity.</p>}
        {report.status === "loading" && <p className="small muted" role="status">Checking the local audit chain…</p>}
        {report.status === "error" && <div className="audit-result invalid" role="alert">
          <AlertTriangle className="icon lg" aria-hidden="true" /><div><h2>Audit verification unavailable.</h2><p>{auditRequestError}</p></div>
        </div>}
        {report.status === "ready" && <AuditReport report={report.data} />}
        <div className="audit-filters workspace-after-content">
          <span className="small muted">A consistent chain does not prove that every action was recorded.</span>
          <button type="button" className="text-link workspace-toolbar-note" onClick={() => setExplanation(true)}>How verification works</button>
        </div>
      </div>
      {explanation && <DetailDialog title="How verification works" description="A local check of the audit log’s internal consistency." onClose={() => setExplanation(false)}>
        <p className="small">AnyBot recomputes each chained record’s SHA-256 hash and checks its link to the previous record. Older entries without hashes cannot be verified.</p>
        <p className="small">A consistent chain can’t reveal actions that were never recorded or a suffix removed at a record boundary. It does not prove that the log is complete or independently trusted.</p>
        <p className="caption-note">The activity view shows a limited summary, not raw log entries or an export. Tools run by external CLI agents are not part of this log.</p>
      </DetailDialog>}
    </section>
  );
}

export default function WorkspacePages(props: WorkspacePagesProps) {
  switch (props.page) {
    case "rooms": return <RoomsPage {...props} />;
    case "workflows": return <WorkflowsPage {...props} />;
    case "agents": return <AgentsPage {...props} />;
    case "files": return <WorkspaceFiles resources={props.resources} onManageWorkspaces={props.onManageWorkspaces} />;
    case "audit": return <AuditPage recordingFailed={props.auditRecordingFailed} />;
  }
}

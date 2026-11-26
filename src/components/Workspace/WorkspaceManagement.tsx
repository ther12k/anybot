import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { WorkspaceBridge, installationsIn } from "../../services/workspace";
import type { BotPersona } from "../../types";
import type { Workspace, WorkspaceAccess, WorkspaceRegistry, WorkspaceTool } from "../../types/workspace";
import "./WorkspaceManagement.css";

interface WorkspaceManagementProps {
  registry: WorkspaceRegistry;
  workspaceId: string;
  bots: BotPersona[];
  onSwitch: (id: string) => void;
  onUpdate: (registry: WorkspaceRegistry) => void;
  onClose: () => void;
}

const toolOptions = [
  { id: "read_file", label: "Read files" },
  { id: "list_directory", label: "List folders" },
  { id: "write_file", label: "Write files" },
  { id: "delegate_task", label: "Ask other installed bots" },
] as const satisfies ReadonlyArray<{ id: WorkspaceTool; label: string }>;

const isAbsoluteFolder = (path: string) => path.startsWith("/") || /^[a-z]:[/\\]/i.test(path) || /^\\\\[^/\\]+[/\\][^/\\]+/.test(path);

type Feedback = { kind: "pending" | "success" | "error"; message: string };

export function WorkspaceManagement({ registry, workspaceId, bots, onSwitch, onUpdate, onClose }: WorkspaceManagementProps) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const switcher = useRef<HTMLSelectElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const installPicker = useRef<HTMLSelectElement>(null);
  const installedPicker = useRef<HTMLSelectElement>(null);
  const uninstallButton = useRef<HTMLButtonElement>(null);
  const cancelUninstall = useRef<HTMLButtonElement>(null);
  const restoreUninstallFocus = useRef(false);
  const requestInFlight = useRef(false);
  const restoreFocus = useRef<(() => HTMLElement | null) | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [folderInvalid, setFolderInvalid] = useState(false);
  const [access, setAccess] = useState<WorkspaceAccess>("read");
  const [personaId, setPersonaId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [draft, setDraft] = useState<WorkspaceTool[] | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  const pending = feedback?.kind === "pending";
  const workspace: Workspace | undefined = registry.workspaces.find(({ id }) => id === workspaceId);
  const installations = installationsIn(registry, workspace?.id);
  const availableBots = bots.filter((bot) => !installations.some((item) => item.persona_id === bot.id));
  const installed = installations.find(({ id }) => id === installationId);
  const installedName = installed && (bots.find(({ id }) => id === installed.persona_id)?.name ?? installed.persona_id);
  const template = registry.templates.find(({ id }) => id === installed?.template_id);
  const allowed = toolOptions.filter(({ id }) => template?.capabilities.includes(id));
  const granted = installed?.tools ?? [];
  const selectedTools = allowed.map(({ id }) => id).filter((tool) => (draft ?? granted).includes(tool));
  const toolsChanged = selectedTools.length !== granted.length || selectedTools.some((tool) => !granted.includes(tool));
  const unlistedGrants = granted.some((tool) => !allowed.some(({ id }) => id === tool));
  const personaAvailable = availableBots.some(({ id }) => id === personaId);
  const templateAvailable = registry.templates.some(({ id }) => id === templateId);
  const canInstall = personaAvailable && templateAvailable;

  useEffect(() => {
    const modal = dialog.current;
    if (!modal) return;
    const opener = document.activeElement;
    modal.showModal();
    heading.current?.focus();
    return () => {
      modal.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    setFolder("");
    setFolderInvalid(false);
    setAccess("read");
    setPersonaId("");
    setTemplateId("");
    setInstallationId("");
    setDraft(null);
    setConfirmUninstall(false);
  }, [workspaceId]);

  useEffect(() => {
    if (pending || !restoreFocus.current) return;
    (restoreFocus.current() ?? heading.current)?.focus();
    restoreFocus.current = null;
  }, [pending]);

  useEffect(() => {
    if (confirmUninstall) cancelUninstall.current?.focus();
    else if (restoreUninstallFocus.current) {
      uninstallButton.current?.focus();
      restoreUninstallFocus.current = false;
    }
  }, [confirmUninstall]);

  function close() {
    if (!requestInFlight.current) onClose();
  }

  async function run(
    request: () => Promise<WorkspaceRegistry>,
    messages: { pending: string; success: string; error: string },
    afterSuccess?: (next: WorkspaceRegistry) => void,
    focusOnSuccess?: () => HTMLElement | null,
  ) {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    const trigger = document.activeElement;
    const returnToTrigger = () => trigger instanceof HTMLElement && trigger.isConnected && dialog.current?.contains(trigger) ? trigger : null;
    setFeedback({ kind: "pending", message: messages.pending });
    try {
      const next = await request();
      onUpdate(next);
      afterSuccess?.(next);
      restoreFocus.current = focusOnSuccess ?? returnToTrigger;
      setFeedback({ kind: "success", message: messages.success });
    } catch (error) {
      const detail = typeof error === "string" ? error : error instanceof Error ? error.message : "";
      restoreFocus.current = returnToTrigger;
      setFeedback({ kind: "error", message: `${messages.error} ${detail.trim() || "Try again."}` });
    } finally {
      requestInFlight.current = false;
    }
  }

  return (
    <dialog ref={dialog} className="modal workspace-dialog workspace-management" aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`} onCancel={(event) => { event.preventDefault(); close(); }}>
      <header className="modal-head">
        <div>
          <h2 ref={heading} tabIndex={-1} id={`${id}-title`}>Manage workspaces</h2>
          <p id={`${id}-description`}>Switch workspaces or manage which folders and bots each one can use.</p>
        </div>
        <button type="button" className="icon-btn" aria-label="Close dialog" disabled={pending} onClick={close}>
          <X className="icon" aria-hidden="true" />
        </button>
      </header>
      <div className="modal-body">
        <fieldset className="workspace-management-controls" disabled={pending}>
          <section className="workspace-management-section" aria-label="Workspaces">
            <div className="field">
              <label htmlFor={`${id}-workspace`}>Active workspace</label>
              <select ref={switcher} id={`${id}-workspace`} value={workspace?.id ?? ""} disabled={!registry.workspaces.length}
                onChange={(event) => {
                  if (requestInFlight.current) return;
                  setFeedback(null);
                  onSwitch(event.target.value);
                }}>
                {!workspace && <option value="" disabled>{registry.workspaces.length ? "Choose a workspace" : "No workspaces yet"}</option>}
                {registry.workspaces.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
              </select>
            </div>
            <form onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim()) return;
              const existing = new Set(registry.workspaces.map(({ id }) => id));
              void run(() => WorkspaceBridge.createWorkspace(name.trim()),
                { pending: "Creating workspace…", success: "Workspace created.", error: "Could not create the workspace." },
                (next) => {
                  const created = [...next.workspaces].reverse().find(({ id }) => !existing.has(id));
                  setName("");
                  if (created) onSwitch(created.id);
                }, () => switcher.current);
            }}>
              <div className="field">
                <label htmlFor={`${id}-name`}>New workspace name</label>
                <input id={`${id}-name`} value={name} required onChange={(event) => setName(event.target.value)} />
              </div>
              <button type="submit" className="btn primary" disabled={!name.trim()}>Create empty workspace</button>
            </form>
          </section>
          {workspace && <>
            <section className="workspace-management-section" aria-labelledby={`${id}-folders`}>
              <h3 id={`${id}-folders`}>Folder grants</h3>
              <p>Folder grants limit where installed bots can use file tools. A cloud model can receive file contents that an agent reads during a turn.</p>
              {workspace.resources.length ? <ul className="workspace-management-folders">
                {workspace.resources.map((resource) => <li key={resource.id}>
                  <div><span>{resource.path}</span><small>{resource.access === "read" ? "Read-only" : "Read/write"}</small></div>
                  <button type="button" className="btn" aria-label={`Remove folder ${resource.path}`} onClick={() => void run(
                    () => WorkspaceBridge.removeResource(workspace.id, resource.id),
                    { pending: "Removing folder grant…", success: "Folder grant removed.", error: "Could not remove the folder grant." },
                    undefined, () => folderInput.current,
                  )}>Remove</button>
                </li>)}
              </ul> : <p>No folders granted.</p>}
              <form onSubmit={(event) => {
                event.preventDefault();
                if (requestInFlight.current) return;
                const path = folder.trim();
                if (!isAbsoluteFolder(path)) {
                  setFolderInvalid(true);
                  setFeedback(null);
                  folderInput.current?.focus();
                  return;
                }
                void run(() => WorkspaceBridge.addResource(workspace.id, path, access),
                  { pending: "Adding folder grant…", success: "Folder grant added.", error: "Could not add the folder grant." },
                  () => { setFolder(""); setAccess("read"); }, () => folderInput.current);
              }}>
                <div className="field">
                  <label htmlFor={`${id}-folder`}>Absolute folder path</label>
                  <input ref={folderInput} id={`${id}-folder`} value={folder} autoComplete="off" spellCheck={false}
                    aria-invalid={folderInvalid || undefined} aria-describedby={folderInvalid ? `${id}-folder-error` : undefined}
                    required onChange={(event) => { setFolder(event.target.value); setFolderInvalid(false); }} />
                  <p id={`${id}-folder-error`} className="workspace-management-error" role="alert">
                    {folderInvalid ? "Enter an absolute folder path. Relative paths and ~ are not accepted here." : ""}
                  </p>
                </div>
                <div className="field">
                  <label htmlFor={`${id}-access`}>Folder access</label>
                  <select id={`${id}-access`} value={access} onChange={(event) => setAccess(event.target.value === "read_write" ? "read_write" : "read")}>
                    <option value="read">Read-only</option><option value="read_write">Read/write</option>
                  </select>
                </div>
                <button type="submit" className="btn" disabled={!folder.trim()}>Add folder grant</button>
              </form>
            </section>
            <section className="workspace-management-section" aria-labelledby={`${id}-bots`}>
              <h3 id={`${id}-bots`}>Installed bots</h3>
              {!installations.length ? <p>No bots installed.</p> : <div className="field">
                <label htmlFor={`${id}-installation`}>Choose a bot to manage</label>
                <select ref={installedPicker} id={`${id}-installation`} value={installed?.id ?? ""} onChange={(event) => {
                  setInstallationId(event.target.value);
                  setDraft(null);
                  setConfirmUninstall(false);
                  setFeedback(null);
                }}>
                  <option value="">Select an installed bot</option>
                  {installations.map((item) => <option key={item.id} value={item.id}>
                    {bots.find(({ id }) => id === item.persona_id)?.name ?? item.persona_id}
                  </option>)}
                </select>
              </div>}
              {installed && <div className="workspace-management-bot">
                <fieldset>
                  <legend>Granted tools</legend>
                  {template ? <p>Template: {template.name}</p> : <p>This bot’s template is unavailable.</p>}
                  {!allowed.length && template && <p>This template offers no tools here.</p>}
                  {allowed.map(({ id, label }) => <label className="checkbox-row" key={id}>
                    <input type="checkbox" checked={selectedTools.includes(id)} disabled={confirmUninstall}
                      onChange={(event) => setDraft(event.target.checked ? [...selectedTools, id] : selectedTools.filter((tool) => tool !== id))} />{label}
                  </label>)}
                  {unlistedGrants && template && <p>Saving removes any existing tool grants that aren’t listed here.</p>}
                </fieldset>
                {confirmUninstall ? <div className="workspace-management-confirm">
                  <p id={`${id}-confirm`}>Uninstall {installedName} from this workspace? Existing chat history stays, but this installation can no longer respond.</p>
                  <div className="workspace-management-actions">
                    <button type="button" className="btn" ref={cancelUninstall} aria-describedby={`${id}-confirm`} onClick={() => {
                      restoreUninstallFocus.current = true;
                      setConfirmUninstall(false);
                      setFeedback(null);
                    }}>Cancel</button>
                    <button type="button" className="btn danger" aria-describedby={`${id}-confirm`} onClick={() => void run(
                      () => WorkspaceBridge.removeBot(installed.id),
                      { pending: "Uninstalling bot…", success: "Bot uninstalled. Chat history was kept.", error: "Could not uninstall the bot." },
                      () => { setInstallationId(""); setDraft(null); setConfirmUninstall(false); },
                      () => installedPicker.current ?? installPicker.current,
                    )}>Confirm uninstall</button>
                  </div>
                </div> : <div className="workspace-management-actions">
                  <button type="button" className="btn" disabled={!template || !toolsChanged} onClick={() => void run(
                    () => WorkspaceBridge.updateBotTools(installed.id, selectedTools),
                    { pending: "Saving tool grants…", success: "Tool grants saved.", error: "Could not save tool grants." },
                    () => setDraft(null), () => installedPicker.current,
                  )}>Save tool grants</button>
                  <button type="button" className="btn danger" ref={uninstallButton} onClick={() => setConfirmUninstall(true)}>Uninstall bot</button>
                </div>}
              </div>}
              <form className="workspace-management-install" aria-labelledby={`${id}-install`} onSubmit={(event) => {
                event.preventDefault();
                if (!canInstall) return;
                void run(() => WorkspaceBridge.installBots(workspace.id, [{ persona_id: personaId, template_id: templateId, tools: [] }]),
                  { pending: "Installing bot…", success: "Bot installed with no tools.", error: "Could not install the bot." },
                  () => { setPersonaId(""); setTemplateId(""); }, () => installedPicker.current);
              }}>
                <h4 id={`${id}-install`}>Install a bot</h4>
                {!availableBots.length ? <p>{bots.length ? "All available bots are installed here." : "No bot personas are available."}</p>
                  : !registry.templates.length ? <p>No bot templates are available.</p> : <>
                    <p>Bots start with no tools. The template determines which tools you can grant later.</p>
                    <div className="field">
                      <label htmlFor={`${id}-persona`}>Bot persona</label>
                      <select ref={installPicker} id={`${id}-persona`} value={personaAvailable ? personaId : ""} required
                        onChange={(event) => setPersonaId(event.target.value)}>
                        <option value="" disabled>Choose a persona</option>
                        {availableBots.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor={`${id}-template`}>Bot template</label>
                      <select id={`${id}-template`} value={templateAvailable ? templateId : ""} required onChange={(event) => setTemplateId(event.target.value)}>
                        <option value="" disabled>Choose a template</option>
                        {registry.templates.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
                      </select>
                    </div>
                    <button type="submit" className="btn" disabled={!canInstall}>Install bot</button>
                  </>}
              </form>
            </section>
          </>}
        </fieldset>
      </div>
      <footer className={`modal-footer workspace-management-feedback${feedback ? " has-feedback" : ""}`}>
        <p role="status">{feedback?.kind !== "error" ? feedback?.message : ""}</p>
        <p id={`${id}-error`} role="alert">{feedback?.kind === "error" ? feedback.message : ""}</p>
      </footer>
    </dialog>
  );
}

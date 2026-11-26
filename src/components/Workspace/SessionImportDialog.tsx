import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useRef, useState } from "react";
import { MAX_IMPORT_FILE_BYTES, parseSessionImport, type ImportedSession } from "../../services/sessionImport";
import { WorkspaceDialog } from "./WorkspaceShell";
import "./SessionImportDialog.css";

interface SessionImportDialogProps {
  desktop: boolean;
  destination: string;
  onImport: (session: ImportedSession) => void;
  onClose: () => void;
}

type RecentZCodeSession = { id: string; title: string; updated_at: number };
type Source = "zcode" | "claude";
type SessionList = { state: "loading" | "error" } | { state: "ready"; sessions: RecentZCodeSession[] };

const MAX_RECENT_SESSIONS = 100;
const updatedAtFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function zcodeSessionLabel({ title, updated_at }: RecentZCodeSession): string {
  const name = title.trim() || "Untitled session";
  const updatedAt = new Date(updated_at);
  return updated_at > 0 && Number.isFinite(updatedAt.getTime()) ? `${name} · ${updatedAtFormat.format(updatedAt)}` : name;
}

export function SessionImportDialog({ desktop, destination, onImport, onClose }: SessionImportDialogProps) {
  const id = useId();
  const request = useRef(0);
  const [source, setSource] = useState<Source | null>(null);
  const [list, setList] = useState<SessionList | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [preview, setPreview] = useState<ImportedSession | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const activeSource = !desktop && source === "zcode" ? null : source;
  const activeList = activeSource === "zcode" ? list : null;
  const readyPreview = activeSource ? preview : null;

  // Ignore any result that arrives after a newer selection, dismissal, or unmount.
  useEffect(() => () => { request.current += 1; }, []);

  function clearPreview() {
    request.current += 1;
    setPreview(null);
    setReading(false);
    setError("");
  }

  async function listSessions() {
    const current = ++request.current;
    setList({ state: "loading" });
    try {
      const sessions = await invoke<RecentZCodeSession[]>("list_zcode_sessions");
      if (current === request.current) {
        setList({ state: "ready", sessions: sessions.slice(0, MAX_RECENT_SESSIONS) });
      }
    } catch {
      if (current === request.current) setList({ state: "error" });
    }
  }

  function chooseSource(next: Source) {
    if ((next === "zcode" && !desktop) || next === activeSource) return;
    clearPreview();
    setSource(next);
    setSessionId("");
    setList(null);
    if (next === "zcode") void listSessions();
  }

  async function loadPreview(read: () => Promise<ImportedSession>, describeError: (error: unknown) => string, onError?: () => void) {
    const current = ++request.current;
    setReading(true);
    setPreview(null);
    setError("");
    try {
      const session = await read();
      if (current !== request.current) return;
      if (!session.messages.length) {
        setError("This session contains no importable text messages. Choose another session.");
        onError?.();
        return;
      }
      setPreview(session);
    } catch (error) {
      if (current !== request.current) return;
      setError(describeError(error));
      onError?.();
    } finally {
      if (current === request.current) setReading(false);
    }
  }

  function chooseFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    clearPreview();
    if (!file) return;
    if (!/\.jsonl$/i.test(file.name)) {
      input.value = "";
      setError("Choose a Claude Code session file ending in .jsonl.");
      return;
    }
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      input.value = "";
      setError(`This file is too large. Choose a Claude Code session file of ${MAX_IMPORT_FILE_BYTES / (1024 * 1024)} MiB or less.`);
      return;
    }
    void loadPreview(async () => {
      const text = await file.text().catch(() => {
        throw new Error("Could not read this file. Choose it again or select another Claude Code session.");
      });
      return parseSessionImport(text, "claude", file.name);
    }, (error) => error instanceof Error ? error.message : "Could not preview this Claude Code file.",
    () => { input.value = ""; });
  }

  function close() {
    request.current += 1;
    onClose();
  }

  function importSession() {
    if (!readyPreview) return;
    try {
      onImport(readyPreview);
    } catch {
      setError("Could not save the imported session. Local storage may be full or unavailable. Free up some space, then try again.");
      return;
    }
    close();
  }

  const messageCount = readyPreview?.messages.length ?? 0;
  const countLabel = `${messageCount} text ${messageCount === 1 ? "message" : "messages"}`;

  return <WorkspaceDialog title="Import session" onClose={close}>
    <div className="session-import">
      <p>Import conversation text only. Importing does not run tools or send anything to a model.</p>
      <fieldset className="session-import-sources">
        <legend>Session source</legend>
        <div className="session-import-actions">
          <button className="btn" type="button" aria-pressed={activeSource === "zcode"}
            disabled={!desktop} onClick={() => chooseSource("zcode")}>ZCode</button>
          <button className="btn" type="button" aria-pressed={activeSource === "claude"}
            onClick={() => chooseSource("claude")}>Claude Code</button>
        </div>
        {!desktop && <p>ZCode import is available only in the desktop app.</p>}
      </fieldset>
      {activeSource === "zcode" && <div className="session-import-source">
        <p id={`${id}-zcode-help`}>Only the {MAX_RECENT_SESSIONS} most recent active, top-level ZCode sessions are available. Choose Preview to read the selected session.</p>
        {activeList?.state === "ready" && activeList.sessions.length > 0 && <div className="field">
          <label htmlFor={`${id}-zcode-session`}>ZCode session</label>
          <select id={`${id}-zcode-session`} value={sessionId} aria-describedby={`${id}-zcode-help`}
            onChange={(event) => { clearPreview(); setSessionId(event.target.value); }}>
            <option value="">Choose a recent session</option>
            {activeList.sessions.map((session) => <option key={session.id} value={session.id}>{zcodeSessionLabel(session)}</option>)}
          </select>
        </div>}
        <div className="session-import-actions">
          {activeList?.state === "ready" && activeList.sessions.length > 0 && <button type="button" className="btn"
            disabled={!sessionId} aria-disabled={reading || undefined} onClick={() => {
              if (!sessionId || reading) return;
              void loadPreview(() => invoke<ImportedSession>("read_zcode_session", { sessionId }),
                (error) => typeof error === "string" && error.trim() ? error
                  : "Could not preview this ZCode session. Choose another session or try again.");
            }}>Preview session</button>}
          <button type="button" className="btn" aria-disabled={activeList?.state === "loading" || undefined} onClick={() => {
            if (activeList?.state === "loading") return;
            clearPreview();
            setSessionId("");
            void listSessions();
          }}>Refresh sessions</button>
        </div>
      </div>}
      {activeSource === "claude" && <div className="session-import-source">
        <p id={`${id}-claude-help`}>Choose one <code>.jsonl</code> file to preview. Claude Code usually saves sessions at <code>{"~/.claude/projects/<project>/<session>.jsonl"}</code>.</p>
        <div className="field">
          <label htmlFor={`${id}-claude-file`}>Claude Code session file</label>
          <input type="file" id={`${id}-claude-file`} accept=".jsonl" aria-describedby={`${id}-claude-help`}
            onChange={(event) => chooseFile(event.currentTarget)} />
        </div>
      </div>}
      <p className={readyPreview ? "sr-only" : "session-import-feedback"} role="status">
        {activeSource && reading ? "Preparing preview…" : activeList?.state === "loading" ? "Loading recent ZCode sessions…"
          : activeList?.state === "ready" && !activeList.sessions.length ? "No recent active ZCode sessions found."
            : readyPreview ? `Preview ready: ${countLabel}.` : ""}
      </p>
      <p className="session-import-feedback" role="alert">
        {activeSource && (error || (activeList?.state === "error" ? "Could not list ZCode sessions. Check that ZCode is installed, then refresh or choose Claude Code." : ""))}
      </p>
      {readyPreview && <div className="session-import-preview">
        <h3>Import preview</h3>
        <p><strong>{readyPreview.title || "Untitled session"}</strong></p>
        <p className="session-import-count">{countLabel}</p>
      </div>}
      <p id={`${id}-destination`}>Import into <strong>{destination}</strong></p>
      <div className="session-import-actions session-import-footer">
        <button type="button" className="btn" onClick={close}>Cancel</button>
        <button type="button" className="btn primary" disabled={!readyPreview} aria-describedby={`${id}-destination`}
          onClick={importSession}>Import session</button>
      </div>
    </div>
  </WorkspaceDialog>;
}

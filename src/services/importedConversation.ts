import type { SessionImportSource, Thread, TranscriptEntry } from "../types";
import type { ImportedSession } from "./sessionImport";

export const importSourceName = (source: SessionImportSource) => source === "zcode" ? "ZCode" : "Claude Code";

const cleanTitle = (title: string) => title.replace(/\s+/g, " ").trim().slice(0, 100).replace(/[\uD800-\uDBFF]$/, "");

export function makeImportedConversation(session: ImportedSession, workspaceId?: string) {
  const id = `thread_${crypto.randomUUID()}`;
  const now = Date.now();
  const entries = session.messages.flatMap(({ role, content, timestamp }): TranscriptEntry[] =>
    (role === "user" || role === "assistant") && typeof content === "string" && content.trim() ? [{
      id: crypto.randomUUID(), threadId: id, role, content,
      timestamp: Number.isSafeInteger(timestamp) && timestamp > 0 && Number.isFinite(new Date(timestamp).getTime()) ? timestamp : 0,
      importedFrom: session.source,
    }] : []);
  if (!entries.length) throw new Error("This session has no chat text to import.");
  const thread: Thread = {
    id, botId: "", title: cleanTitle(session.title) || `${importSourceName(session.source)} session`,
    workspaceId, importedFrom: session.source, createdAt: entries.find((entry) => entry.timestamp)?.timestamp ?? now, updatedAt: now,
  };
  return { thread, entries };
}

export function continueImportedConversation(
  archive: Thread,
  entries: TranscriptEntry[],
  target: { botId: string; modelId: string; workspaceId?: string; installationId?: string },
) {
  if (!archive.importedFrom || archive.workspaceId !== target.workspaceId || (target.workspaceId && !target.installationId)) {
    throw new Error("Choose an installed agent in the workspace that owns this import.");
  }
  const id = `thread_${crypto.randomUUID()}`;
  const now = Date.now();
  const thread: Thread = {
    id, botId: target.botId, modelId: target.modelId, workspaceId: target.workspaceId, installationId: target.installationId,
    title: cleanTitle(`${archive.title.slice(0, 88)} · continued`), createdAt: now, updatedAt: now,
  };
  return {
    thread,
    entries: entries.flatMap(({ threadId, role, content, timestamp }): TranscriptEntry[] =>
      threadId === archive.id && (role === "user" || role === "assistant") ? [{
        id: crypto.randomUUID(), threadId: id, role, content, timestamp, importedFrom: archive.importedFrom,
      }] : []),
  };
}

export function persistImportedConversation(
  storage: Pick<Storage, "setItem">,
  currentThreads: Thread[],
  currentTranscripts: Record<string, TranscriptEntry[]>,
  thread: Thread,
  entries: TranscriptEntry[],
) {
  const threads = [thread, ...currentThreads];
  const transcripts = { ...currentTranscripts, [thread.id]: entries };
  try {
    // Save the text before publishing the thread in the list.
    storage.setItem("anybot_transcripts", JSON.stringify(transcripts));
    try {
      storage.setItem("anybot_threads", JSON.stringify(threads));
    } catch (error) {
      storage.setItem("anybot_transcripts", JSON.stringify(currentTranscripts));
      throw error;
    }
  } catch {
    throw new Error("Could not save the conversation in local storage. Free up space and try again.");
  }
  return { threads, transcripts };
}

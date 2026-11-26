export interface ImportedSession {
  source: "claude" | "zcode";
  title: string;
  messages: { role: "user" | "assistant"; content: string; timestamp: number }[];
}

export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_HISTORY_BYTES = 512 * 1024;
const MAX_HISTORY_MESSAGES = 400;
const encoder = new TextEncoder();

type ImportedMessage = ImportedSession["messages"][number];
type RecordValue = Record<string, unknown>;
type ClaudeTurn = { message: ImportedMessage; timestamp?: number };
type ClaudeNode = {
  id: string;
  parent?: string;
  sidechain: boolean;
  responseId?: string;
  turns: ClaudeTurn[];
  line: number;
};
type Trace = { root: string; head?: ClaudeNode };
type Checkpoint = { id: string; line: number; explicit: boolean };

const noMessages = "This Claude Code session has no importable user or assistant text.";
const ambiguous = "This Claude Code file has multiple branches and no clear active conversation.";
const injectedUserText = /^(?:<(?:system-reminder|local-command-(?:caveat|stdout|stderr)|command-(?:name|message|args)|bash-(?:input|stdout|stderr)|task-notification|teammate-message|user-prompt-submit-hook)(?=[\s/>])|\[Request interrupted by user[^\]]*\]$)/i;

function asRecord(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function hidden(value: RecordValue): boolean {
  return value.isMeta === true || value.isVirtual === true || value.isCompactSummary === true ||
    value.isVisibleInTranscriptOnly === true || value.isDisplayOnly === true || value.isApiErrorMessage === true;
}

function readTurn(row: RecordValue, message: RecordValue, role: ImportedMessage["role"]): ClaudeTurn | undefined {
  if (hidden(row) || hidden(message) || message.model === "<synthetic>" || row.promptSource === "system") return;
  if (role === "user" && typeof row.sourceToolAssistantUUID === "string") return;
  const origin = asRecord(row.origin);
  if (origin?.kind === "task-notification" || origin?.kind === "scheduled-trigger" ||
      (origin?.kind === "plugin" && origin.asUser !== true)) return;

  const parts = Array.isArray(message.content) ? message.content.flatMap((part) => {
    const block = asRecord(part);
    return block?.type === "text" && !hidden(block) ? [block.text] : [];
  }) : [message.content];
  const content = parts.filter((part): part is string => typeof part === "string" && part.trim() !== "" &&
    !(role === "user" && injectedUserText.test(part.trim()))).join("\n\n");
  if (!content) return;

  const parsed = typeof row.timestamp === "string" && /^\d{4}-\d{2}-\d{2}T/.test(row.timestamp)
    ? Date.parse(row.timestamp) : NaN;
  const timestamp = Number.isFinite(parsed) ? parsed : undefined;
  return { message: { role, content, timestamp: timestamp ?? 0 }, timestamp };
}

function titleFrom(value: string | undefined): string | undefined {
  return value?.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 120).replace(/[\uD800-\uDBFF]$/, "") || undefined;
}

function filenameTitle(filename: string | undefined): string | undefined {
  return titleFrom(filename?.split(/[\\/]/).pop()?.replace(/\.jsonl$/i, ""));
}

// Claude can persist blocks from one assistant response as siblings. Rejoin
// only those with the same provider message ID AND the same direct parent.
function joinAssistantSiblings(nodes: Map<string, ClaudeNode>): void {
  const responses = new Map<string, ClaudeNode>();
  for (const node of nodes.values()) {
    if (node.sidechain || !node.responseId || !node.parent) continue;
    const key = JSON.stringify([node.parent, node.responseId]);
    const first = responses.get(key);
    if (!first) responses.set(key, node);
    else {
      first.turns.push(...node.turns);
      if (node.turns.length) first.line = node.line;
      nodes.set(node.id, first);
    }
  }
}

function selectConversation(nodes: Map<string, ClaudeNode>, checkpoint?: Checkpoint): ImportedMessage[] {
  joinAssistantSiblings(nodes);
  const traces = new Map<ClaudeNode, Trace | null>();
  const parents = new Map<ClaudeNode, ClaudeNode | undefined>();
  const heads = new Set<ClaudeNode>();
  const roots = new Set<string>();
  let lastVisibleLine = 0;

  // Walk the links, not timestamp or file order. Hidden records still connect
  // turns; a sidechain and anything descended from it are not eligible.
  for (const node of nodes.values()) {
    if (traces.has(node)) continue;
    const path = new Set<ClaudeNode>();
    let current: ClaudeNode | undefined = node;
    let root = node.id;
    while (current && !traces.has(current) && !current.sidechain) {
      if (path.has(current)) throw new Error("This Claude Code file contains a cycle in its message links.");
      path.add(current);
      root = current.parent ?? current.id;
      current = current.parent ? nodes.get(current.parent) : undefined;
    }
    let trace = current ? traces.get(current) ?? null : { root };
    if (current?.sidechain) traces.set(current, null);
    for (const entry of [...path].reverse()) {
      if (trace && entry.turns.length) {
        parents.set(entry, trace.head);
        if (trace.head) heads.delete(trace.head);
        heads.add(entry);
        roots.add(trace.root);
        lastVisibleLine = Math.max(lastVisibleLine, entry.line);
        trace = { root: trace.root, head: entry };
      }
      traces.set(entry, trace);
    }
  }

  if (!heads.size) throw new Error(noMessages);
  if (roots.size > 1) throw new Error("This Claude Code file contains disconnected conversations. Import one session file at a time.");

  if (checkpoint) {
    const target = nodes.get(checkpoint.id);
    const head = target && traces.get(target)?.head;
    if (checkpoint.line > lastVisibleLine) {
      // Only a rewind can intentionally select an interior node. An ordinary
      // last-prompt pointer may outlive the user prompt it was written for.
      if (checkpoint.explicit && !head) {
        throw new Error("This Claude Code file is missing the conversation at its latest rewind point.");
      }
      if (head && (checkpoint.explicit || heads.has(head))) {
        heads.clear();
        heads.add(head);
      }
    } else if (checkpoint.explicit && head) {
      // Prefer actual descendants appended after a rewind over abandoned
      // suffixes, even if the recording clock went backwards on resume.
      const descended = new Set([head]);
      for (const [node, parent] of parents) {
        if (parent && descended.has(parent)) descended.add(node);
      }
      const resumed = [...heads].filter((node) => node.line > checkpoint.line && descended.has(node));
      if (resumed.length) {
        heads.clear();
        for (const node of resumed) heads.add(node);
      }
    }
  }

  let active: ClaudeNode | undefined;
  if (heads.size === 1) {
    active = heads.values().next().value;
  } else {
    // Claude falls back to the latest dated leaf. Without a unique, dated
    // winner, don't splice branches or guess from JSONL append order.
    let newest = -Infinity;
    for (const head of heads) {
      const timestamp = head.turns[head.turns.length - 1].timestamp;
      if (timestamp === undefined) throw new Error(ambiguous);
      if (timestamp > newest) {
        active = head;
        newest = timestamp;
      } else if (timestamp === newest) {
        active = undefined;
      }
    }
    if (!active) throw new Error(ambiguous);
  }

  const messages: ImportedMessage[] = [];
  let bytes = 2; // JSON array delimiters
  for (let node = active; node; node = parents.get(node)) {
    for (let index = node.turns.length - 1; index >= 0; index--) {
      const { message } = node.turns[index];
      if (messages.length >= MAX_HISTORY_MESSAGES) {
        throw new Error("This session exceeds the 400-message import limit.");
      }
      bytes += encoder.encode(JSON.stringify(message)).byteLength + (messages.length ? 1 : 0);
      if (bytes > MAX_HISTORY_BYTES) throw new Error("This session exceeds the 512 KiB retained history limit.");
      messages.push(message);
    }
  }
  return messages.reverse();
}

export function parseSessionImport(
  text: string, source: ImportedSession["source"], filename?: string,
): ImportedSession {
  if (source === "zcode") throw new Error("Use the local ZCode session picker to import a ZCode session.");
  if (text.length > MAX_IMPORT_FILE_BYTES || encoder.encode(text).byteLength > MAX_IMPORT_FILE_BYTES) {
    throw new Error("The session file exceeds the 10 MiB import limit.");
  }

  const nodes = new Map<string, ClaudeNode>();
  let sessionId: string | undefined;
  let title: string | undefined;
  let aiTitle: string | undefined;
  let checkpoint: Checkpoint | undefined;
  let line = 0;
  for (let start = 0, end = 0; start < text.length; start = end + 1) {
    end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    line++;
    const raw = text.slice(start, end).trim(); // Handles CRLF and a leading BOM.
    if (!raw) continue;
    let row: RecordValue | undefined;
    try {
      row = asRecord(JSON.parse(raw));
    } catch {
      // Native JSON parse errors may quote private text from the bad row.
    }
    if (!row || typeof row.type !== "string") {
      throw new Error(`Invalid Claude Code JSONL record on line ${line}.`);
    }

    const role = row.type === "user" || row.type === "assistant" ? row.type : undefined;
    const message = asRecord(row.message);
    const sidechain = row.isSidechain === true;
    const boundary = row.type === "system" && row.subtype === "compact_boundary";
    const titleRecord = row.type === "custom-title" || row.type === "ai-title";
    const lastPrompt = row.type === "last-prompt";
    if (!sidechain && (role || boundary || titleRecord || lastPrompt)) {
      const id = nonemptyString(row.sessionId);
      if (sessionId && id && id !== sessionId) {
        throw new Error("This Claude Code file contains multiple sessions. Import one session file at a time.");
      }
      sessionId ??= id;
      if (row.type === "custom-title") title = titleFrom(nonemptyString(row.customTitle)) ?? title;
      if (row.type === "ai-title") aiTitle = titleFrom(nonemptyString(row.aiTitle)) ?? aiTitle;
      if (lastPrompt) {
        const explicit = row.explicit === true || row.rewound === true;
        const leaf = nonemptyString(row.leafUuid);
        if (explicit && row.leafUuid === null) {
          nodes.clear();
          checkpoint = undefined;
        } else if (leaf) {
          checkpoint = { id: leaf, line, explicit: explicit || (checkpoint?.id === leaf && checkpoint.explicit) };
        }
      }
    }

    if (!role && !sidechain && !boundary && !("parentUuid" in row)) continue;
    const id = nonemptyString(row.uuid);
    const turn = !sidechain && role && message?.role === role ? readTurn(row, message, role) : undefined;
    if (!id) {
      if (turn) throw new Error(`Claude Code message on line ${line} is missing its conversation link.`);
      continue;
    }
    const parent = nonemptyString(row.parentUuid) ?? (boundary ? nonemptyString(row.logicalParentUuid) : undefined);
    const responseId = role === "assistant" && message?.role === role ? nonemptyString(message.id) : undefined;
    const previous = nodes.get(id);
    if (previous) {
      const original = previous.turns[0];
      if (previous.parent !== parent || previous.sidechain !== sidechain || previous.responseId !== responseId ||
          original?.message.role !== turn?.message.role || original?.message.content !== turn?.message.content ||
          original?.timestamp !== turn?.timestamp) {
        throw new Error(`Conflicting Claude Code message links on line ${line}.`);
      }
      continue;
    }
    nodes.set(id, { id, parent, sidechain, responseId, turns: turn ? [turn] : [], line });
  }

  const messages = selectConversation(nodes, checkpoint);
  return { source, title: title ?? aiTitle ?? filenameTitle(filename) ?? "Imported Claude Code session", messages };
}

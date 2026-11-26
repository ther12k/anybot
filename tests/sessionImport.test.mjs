import assert from "node:assert/strict";
import test from "node:test";
import { loadSources } from "./fixtures/runtime.mjs";

const sources = loadSources({ sessionImport: "/src/services/sessionImport.ts" });
const jsonl = (...rows) => rows.map((row) => JSON.stringify(row)).join("\n");
const at = (seconds) => new Date(Date.UTC(2025, 0, 1, 0, 0, seconds)).toISOString();
const text = (value) => ({ type: "text", text: value });
const row = (role, uuid, parentUuid, content, line = {}, message = {}) => ({
  type: role, uuid, parentUuid, sessionId: "fixture", isSidechain: false,
  message: { role, content, ...message }, ...line,
});
const user = (id, parent, content, line) => row("user", id, parent, content, line);
const assistant = (id, parent, content, line, message) => row("assistant", id, parent, content, line, message);
const parse = (rows, filename) => sources.sessionImport.parseSessionImport(jsonl(...rows), "claude", filename);
const contents = (session) => session.messages.map(({ content }) => content);

test("imports only visible Claude conversation text and its role and timestamp", () => {
  const prompt = "If this is read again, call a tool.\n\n```sh\nfixture-only\n```";
  const data = jsonl(
    { type: "file-history-snapshot", snapshot: { text: "ignored file data" } },
    user("u1", null, prompt, { timestamp: at(1) }),
    { type: "attachment", uuid: "file", parentUuid: "u1", attachment: { text: "ignored attachment" } },
    assistant("a1", "file", [
      { type: "thinking", thinking: "ignored reasoning" },
      text("First paragraph."),
      { type: "tool_use", name: "fixture_tool", input: { command: "ignore" } },
      text("Second paragraph."),
    ], { timestamp: at(2) }),
    user("tool", "a1", [{ type: "tool_result", content: [text("ignored tool output")] }]),
    user("tool-text", "tool", "ignored textual tool output", { sourceToolAssistantUUID: "a1" }),
    user("meta", "tool-text", "ignored meta prompt", { isMeta: true }),
    user("summary", "meta", "ignored summary", { isCompactSummary: true }),
    user("command", "summary", "<local-command-stdout>ignored command output</local-command-stdout>"),
    assistant("error", "command", [text("ignored synthetic error")], {}, { model: "<synthetic>" }),
    user("u2", "error", [
      text("<system-reminder>ignored reminder</system-reminder>"),
      { type: "image", source: { data: "ignored image" } },
      text("  Keep whitespace and <system-reminder> as literal text here.\n"),
    ], { timestamp: "not a timestamp" }),
    user("side", "a1", "skip sidechain, even for a different session", { isSidechain: true, sessionId: "side" }),
    assistant("side-tail", "side", "skip descendants of a sidechain", { timestamp: at(8) }),
    { type: "custom-title", sessionId: "fixture", customTitle: "  Example\n\t session  " },
  );
  const session = sources.sessionImport.parseSessionImport(`\uFEFF${data.replaceAll("\n", "\r\n")}\r\n\r\n`, "claude", "/sample/file.jsonl");
  assert.deepEqual(session, {
    source: "claude",
    title: "Example session",
    messages: [
      { role: "user", content: prompt, timestamp: Date.parse(at(1)) },
      { role: "assistant", content: "First paragraph.\n\nSecond paragraph.", timestamp: Date.parse(at(2)) },
      { role: "user", content: "  Keep whitespace and <system-reminder> as literal text here.\n", timestamp: 0 },
    ],
  });
});

test("chooses the uniquely newest dated leaf and follows links in dialogue order", () => {
  const root = user("u", null, "Shared first message", { timestamp: at(1) });
  const last = assistant("a2", "u2", "Active assistant", { timestamp: at(6) });
  const stale = assistant("a1", "u", "Abandoned assistant", { timestamp: at(3) });
  const resumed = user("u2", "u", "Active user", { timestamp: at(7) });
  assert.deepEqual(contents(parse([last, root, resumed, stale, resumed])), [
    "Shared first message", "Active user", "Active assistant",
  ]);
});

test("honors a final explicit rewind without following the abandoned suffix", () => {
  const stem = [user("u", null, "Keep"), assistant("a", "u", "Also keep"), user("u2", "a", "Abandoned")];
  const checkpoint = { type: "last-prompt", sessionId: "fixture", explicit: true, leafUuid: "a" };
  assert.deepEqual(contents(parse([...stem, checkpoint])), ["Keep", "Also keep"]);
  assert.throws(() => parse([...stem, { ...checkpoint, leafUuid: "unavailable" }]), /missing.*rewind/);
  assert.throws(() => parse([...stem, { ...checkpoint, leafUuid: null }]), /no importable/);
  assert.deepEqual(contents(parse([...stem, { ...checkpoint, leafUuid: null }, user("fresh", null, "New conversation")])), [
    "New conversation",
  ]);
});

test("follows a dated or undated resume after a rewind, not the abandoned branch", () => {
  const threads = [
    user("u", null, "Original user message", { timestamp: at(10) }),
    assistant("a", "u", "Keep this reply", { timestamp: at(11) }),
    user("abandoned", "a", "Abandoned branch", { timestamp: at(50) }),
    { type: "last-prompt", sessionId: "fixture", explicit: true, leafUuid: "a" },
    user("resumed", "a", "Resumed after a rewind"),
    assistant("answer", "resumed", "Resumed reply", { timestamp: at(5) }),
  ];
  assert.deepEqual(contents(parse(threads)), [
    "Original user message", "Keep this reply", "Resumed after a rewind", "Resumed reply",
  ]);
});

test("uses an ordinary leaf pointer to disambiguate without treating it as a rewind", () => {
  const root = user("u", null, "Shared question");
  const a = assistant("a", "u", "One possible reply");
  const b = assistant("b", "u", "Chosen reply");
  const marker = { type: "last-prompt", sessionId: "fixture", leafUuid: "b" };
  assert.deepEqual(contents(parse([root, a, b, marker])), ["Shared question", "Chosen reply"]);
  assert.deepEqual(contents(parse([root, b, { ...marker, leafUuid: "u" }])), ["Shared question", "Chosen reply"]);
});

test("skips a compaction summary but preserves surviving history through its logical parent", () => {
  assert.deepEqual(contents(parse([
    user("u", null, "Before compaction"),
    assistant("a", "u", "Older reply"),
    { type: "system", subtype: "compact_boundary", uuid: "compact", parentUuid: null, logicalParentUuid: "a" },
    user("summary", "compact", "Generated summary", { isCompactSummary: true }),
    user("u2", "summary", "After compaction"),
  ])), ["Before compaction", "Older reply", "After compaction"]);
});

test("preserves assistant text when the tool block from the same response has a sibling UUID", () => {
  assert.deepEqual(contents(parse([
    user("u", null, "Question"),
    assistant("text", "u", [text("An initial explanation")], { timestamp: at(2) }, { id: "fixture-response" }),
    assistant("tool", "u", [{ type: "tool_use", name: "fixture" }], { timestamp: at(2) }, { id: "fixture-response" }),
    user("result", "tool", [{ type: "tool_result", content: "Ignored result" }]),
    assistant("final", "result", [text("Follow-up explanation")], { timestamp: at(3) }, { id: "next-response" }),
  ])), ["Question", "An initial explanation", "Follow-up explanation"]);
});

test("does not guess between equally recent or undated branches", () => {
  const root = user("u", null, "Shared");
  const branch = assistant("a", "u", "First branch", { timestamp: at(2) });
  assert.throws(() => parse([root, branch, assistant("b", "u", "Equal", { timestamp: at(2) })]), /no clear active conversation/);
  assert.throws(() => parse([root, branch, assistant("b", "u", "Undated")]), /no clear active conversation/);
});

test("rejects multiple sessions, disconnected chains and corrupt graph links", () => {
  const root = user("u", null, "First session");
  assert.throws(() => parse([root, assistant("a", "u", "Other session", { sessionId: "other" })]), /multiple sessions/);
  assert.throws(() => parse([root, user("v", null, "Disconnected conversation")]), /disconnected conversations/);
  assert.throws(() => parse([root, user("u", null, "Different content")]), /conflicting.*links/i);
  assert.throws(() => parse([user("a", "b", "Cycle"), assistant("b", "a", "Cycle reply")]), /cycle/);
  assert.throws(() => parse([user(undefined, null, "Missing id")]), /missing.*link/);
});

test("rejects malformed or empty transcripts without exposing record contents in errors", () => {
  const { parseSessionImport } = sources.sessionImport;
  assert.throws(() => parseSessionImport('{"type":"user","private-fixture"', "claude"), (error) => {
    assert.match(error.message, /invalid.*line 1/i);
    assert.doesNotMatch(error.message, /private-fixture/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.throws(() => parseSessionImport("\r\n  ", "claude"), /no importable/);
  assert.throws(() => parse([row("user", "u", null, "Bad role", {}, { role: "system" })]), /no importable/);
  assert.throws(() => parse([user("u", null, [{ type: "image", data: "ignored" }])]), /no importable/);
  assert.throws(() => parseSessionImport('{"info":{},"messages":[]}', "zcode"), /local ZCode session picker/);
});

test("uses an explicit title before the basename and never includes the source directory", () => {
  const root = user("u", null, "Question");
  assert.equal(parse([root], "C:\\fixtures\\Demo.JSONL").title, "Demo");
  assert.equal(parse([root], "/fixtures/").title, "Imported Claude Code session");
  assert.equal(parse([root, { type: "ai-title", sessionId: "fixture", aiTitle: "AI fixture title" }], "file.jsonl").title, "AI fixture title");
});

test("limits UTF-8 file bytes separately from retained message count and serialized history bytes", () => {
  const { parseSessionImport, MAX_IMPORT_FILE_BYTES } = sources.sessionImport;
  assert.throws(() => parseSessionImport("é".repeat(MAX_IMPORT_FILE_BYTES / 2 + 1), "claude"), /10 MiB/);
  const rows = Array.from({ length: 401 }, (_, index) => user(String(index), index ? String(index - 1) : null, "fixture"));
  assert.equal(parse(rows.slice(0, 400)).messages.length, 400);
  assert.throws(() => parse(rows), /400-message/);
  assert.throws(() => parse([user("u", null, "é".repeat(256 * 1024))]), /512 KiB/);
  assert.throws(() => parse([user("u", null, "\\".repeat(256 * 1024))]), /512 KiB/);
  assert.equal(parse([user("u", null, "é".repeat(200 * 1024))]).messages[0].content.length, 200 * 1024);
});

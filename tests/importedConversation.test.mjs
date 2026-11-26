import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { loadSources } from "./fixtures/runtime.mjs";

const sources = loadSources({ imports: "/src/services/importedConversation.ts" });
if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const session = {
  source: "zcode", title: "Example session",
  messages: [
    { role: "user", content: "Hello", timestamp: 100 },
    { role: "assistant", content: "Hi", timestamp: 200, toolCalls: [{ id: "proposal" }] },
    { role: "tool", content: "Private tool output", timestamp: 300 },
  ],
  tools: ["write_file"],
};

test("import creates a local read-only record with text and source only", () => {
  const { makeImportedConversation } = sources.imports;
  const { thread, entries } = makeImportedConversation(session, "workspace-a");
  assert.equal(thread.importedFrom, "zcode");
  assert.equal(thread.workspaceId, "workspace-a");
  assert.equal(thread.installationId, undefined);
  assert.equal(thread.modelId, undefined);
  assert.deepEqual(entries.map(({ role, content, timestamp }) => [role, content, timestamp]), [
    ["user", "Hello", 100], ["assistant", "Hi", 200],
  ]);
  assert(entries.every((entry) => entry.threadId === thread.id && entry.importedFrom === "zcode" && !entry.toolCalls));
});

test("continuation requires a same-workspace installation and leaves the archive untouched", () => {
  const { makeImportedConversation, continueImportedConversation } = sources.imports;
  const { thread, entries } = makeImportedConversation(session, "workspace-a");
  const original = structuredClone({ thread, entries });
  const target = { workspaceId: "workspace-a", installationId: "installed", modelId: "phi3:mini", botId: "general" };
  assert.throws(() => continueImportedConversation(thread, entries, { ...target, workspaceId: "workspace-b" }), /workspace/);
  assert.throws(() => continueImportedConversation(thread, entries, { ...target, installationId: undefined }), /installed agent/);
  const continuation = continueImportedConversation(thread, entries, target);
  assert.notEqual(continuation.thread.id, thread.id);
  assert.equal(continuation.thread.importedFrom, undefined);
  assert.equal(continuation.thread.installationId, "installed");
  assert.deepEqual(continuation.entries.map(({ content }) => content), ["Hello", "Hi"]);
  assert(continuation.entries.every((entry, index) => entry.id !== entries[index].id && entry.importedFrom === "zcode"));
  assert.deepEqual({ thread, entries }, original);
});

test("a failed thread save rolls back staged transcript changes", () => {
  const { makeImportedConversation, persistImportedConversation } = sources.imports;
  const { thread, entries } = makeImportedConversation(session);
  const old = { existing: [{ content: "Saved history" }] };
  const data = new Map([["anybot_transcripts", JSON.stringify(old)]]);
  const storage = { setItem(key, value) {
    if (key === "anybot_threads") throw new Error("quota");
    data.set(key, value);
  } };
  assert.throws(() => persistImportedConversation(storage, [], old, thread, entries), /local storage/);
  assert.deepEqual(JSON.parse(data.get("anybot_transcripts")), old);
  assert.equal(data.has("anybot_threads"), false);
});

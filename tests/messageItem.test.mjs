import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadSources } from "./fixtures/runtime.mjs";

const sources = loadSources({ messages: "/src/components/Chat/MessageItem.tsx" });
const base = { id: "reply", threadId: "chat", role: "assistant", content: "", timestamp: 1 };
const render = (entry, props = {}) => renderToStaticMarkup(createElement(sources.messages.MessageItem, {
  entry, bot: { name: "Test agent" }, ...props,
}));

test("assistant Markdown displays image descriptions without requesting remote images", () => {
  const result = render({ ...base, content: "![Preview](https://example.invalid/preview.png)" });
  assert.match(result, /\[Image: Preview\]/);
  assert.doesNotMatch(result, /<img|https:\/\/example\.invalid/);
});

test("only the live reviewed action exposes approval controls", () => {
  const entry = { ...base, toolCalls: [
    { id: "unbound", providerCallId: "shared", name: "read_file", status: "pending_approval", arguments: { path: "/notes.txt" } },
    { id: "queued", providerCallId: "shared", name: "read_file", status: "queued", arguments: { path: "/todo.txt" } },
    { id: "review", providerCallId: "shared", name: "write_file", status: "pending_approval", proposalId: "review-token",
      arguments: { path: "/draft.txt" }, result: { diff: { path: "/draft.txt", before: "old", after: "new" } } },
  ] };
  const markup = render(entry, { canReviewTool: (id) => id === "review", onApproveTool() {}, onRejectTool() {} });
  assert.match(markup, /Queued/);
  assert.match(markup, /Approve &amp; Apply/);
  assert.doesNotMatch(markup, /Approve once/);
  assert.equal((markup.match(/>Reject<\/button>/g) ?? []).length, 1);
});

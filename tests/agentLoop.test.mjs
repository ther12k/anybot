import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSources, stubIO } from "./fixtures/runtime.mjs";

const sources = loadSources({
  agent: "/src/services/agent/agentLoop.ts",
  bridge: "/src/services/tauri/bridge.ts",
});

const model = {
  id: "fixture-model",
  name: "Fixture model",
  provider: "ollama",
  contextWindow: 4096,
  supportsTools: true,
  supportsThinking: false,
};
const vault = { ollamaBaseUrl: "http://fixture.invalid", autoApproveSafeTools: true };
const bot = {
  id: "fixture-bot",
  name: "Fixture bot",
  slug: "fixture-bot",
  description: "Fixture persona",
  avatar: "F",
  systemPrompt: "Only discuss the fixture.",
  defaultModel: model.id,
  temperature: 0,
  autoApproveSafeTools: true,
};

const action = { command: "ls fixture-files", cwd: "/fixture/workspace" };
const shell = (args = action) => ({ name: "execute_shell", arguments: args });
const failedExit = {
  success: false, exit_code: 23, stdout: "Fixture pré-check", stderr: "Fixture folder not found.",
  execution_time_ms: 5,
};
const successfulExit = {
  success: true, exit_code: 0, stdout: "fixture.txt", stderr: "", execution_time_ms: 4,
};
const checkShellSafety = async (command) => ({
  command, tier: "Safe", reason: "Read-only fixture", requires_confirmation: false, standing_grant: false,
});
const shellReplies = (...results) => ({
  checkShellSafety,
  executeShellCommand: async () => {
    assert.ok(results.length, "Unexpected extra shell execution");
    return results.shift();
  },
});
const reply = (content, ...tools) => ({ content, tools });
const finalReply = reply("The fixture checks are done.");

async function runFixture(t, replies, { native, decisions = [], supportsTools = true, sameTick = false } = {}) {
  const requests = [];
  const bridge = stubIO(t, sources.bridge.TauriBridge, {
    native,
    fetch: async (url, init) => {
      const next = replies[requests.length];
      requests.push({ url, body: JSON.parse(init.body) });
      assert.ok(next, "Provider asked for an unscripted follow-up");
      if (next instanceof Response) return next;
      return new Response([
        { message: { content: next.content, tool_calls: next.tools.map((tool) => ({ function: tool })) } },
        { done: true },
      ].map((frame) => `${JSON.stringify(frame)}\n`).join(""), {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    },
  });

  const threadId = "fixture-thread";
  const timestamp = 1_700_000_000_000;
  let tick = 0;
  t.mock.method(Date, "now", () => timestamp + (sameTick ? 0 : tick++));
  let randomSequence = 0;
  t.mock.method(Math, "random", () => 0.123456789012 + ++randomSequence / 1_000_000);
  let entries = [];
  const approvals = [];
  const outcome = await new sources.agent.AgentLoop().runTurn(
    threadId,
    [{ id: "fixture-user", threadId, timestamp, role: "user", content: "Check the fixture." }],
    bot,
    { ...model, supportsTools },
    vault,
    (update) => { entries = entries.map((entry) => entry.id === update.id ? structuredClone(update) : entry); },
    (entry) => { entries.push(structuredClone(entry)); },
    (tool, resolve) => {
      const approved = decisions[approvals.length];
      approvals.push(structuredClone(tool));
      assert.notEqual(approved, undefined, "Approval was not scripted for this action");
      resolve(approved);
    },
  );

  assert.equal(requests.length, replies.length, "Provider reply count");
  assert.ok(requests.every(({ url }) => url === "http://fixture.invalid/api/chat"), "Only the fixture endpoint is used");
  assert.equal(approvals.length, decisions.length, "Human approval request count");
  return { outcome, requests, entries, approvals, bridge };
}

const toolResults = (request) => request.body.messages.filter(({ role }) => role === "tool");

test("a successful shell action and follow-up complete a run", async (t) => {
  const { entries, outcome } = await runFixture(t, [reply("Inspecting the fixture.", shell()), finalReply], {
    native: shellReplies(successfulExit),
  });
  assert.equal(outcome, "completed");
  assert.equal(entries[0].toolCalls[0].status, "completed");
  assert.equal(entries[0].toolCalls[0].result.exitCode, 0);
  assert.equal(entries[1].content, finalReply.content);
});

test("a nonzero shell exit fails the run and reports the actual code to the transcript and model", async (t) => {
  const { outcome, entries, requests } = await runFixture(t, [reply("Inspecting the fixture.", shell()), finalReply], {
    native: shellReplies(failedExit),
  });
  assert.equal(outcome, "failed");
  const [call] = entries[0].toolCalls;
  assert.equal(call.status, "failed");
  assert.equal(call.result.exitCode, 23);
  assert.ok(call.result.output.includes(failedExit.stdout));
  assert.ok(call.result.output.includes(failedExit.stderr));
  const [result] = toolResults(requests[1]);
  assert.match(result.content, /tool status:\s*failed\b/i);
  assert.match(result.content, /exit code 23\b/i);
  assert.ok(result.content.includes(failedExit.stderr));
});

for (const [difference, unrelated] of [
  ["command", { ...action, command: "ls another-fixture-folder" }],
  ["working directory", { ...action, cwd: "/fixture/another-workspace" }],
]) {
  test(`a later shell success with a different ${difference} does not recover the failure`, async (t) => {
    const { outcome, bridge, entries } = await runFixture(t, [
      reply("Inspecting the fixture.", shell()), reply("Inspecting a different fixture.", shell(unrelated)), finalReply,
    ], { native: shellReplies(failedExit, successfulExit) });
    assert.equal(outcome, "failed");
    assert.deepEqual(bridge.executeShellCommand.mock.calls.map(({ arguments: args }) => args.slice(0, 2)), [
      [action.command, action.cwd], [unrelated.command, unrelated.cwd],
    ]);
    assert.equal(entries[0].toolCalls[0].status, "failed");
    assert.equal(entries[1].toolCalls[0].status, "completed");
    assert.deepEqual(entries[1].toolCalls[0].recoveredToolCallIds ?? [], []);
  });
}

test("an exact retry in a later provider reply recovers while keeping both assistant entries", async (t) => {
  // All replies can arrive in one clock tick: entry IDs must still be unique.
  const { outcome, entries, requests } = await runFixture(t, [
    reply("Inspecting the fixture.", shell()), reply("Retrying the fixture check.", shell()), finalReply,
  ], { native: shellReplies(failedExit, successfulExit), sameTick: true });
  assert.equal(outcome, "completed");
  const [original, retry, summary] = entries;
  assert.equal(new Set(entries.map(({ id }) => id)).size, 3);
  assert.equal(original.role, "assistant");
  assert.equal(retry.role, "assistant");
  assert.equal(original.content, "Inspecting the fixture.");
  assert.equal(retry.content, "Retrying the fixture check.");
  assert.equal(summary.content, finalReply.content);
  const [failure] = original.toolCalls;
  const [recovery] = retry.toolCalls;
  assert.notEqual(failure.id, recovery.id);
  assert.equal(failure.status, "failed");
  assert.equal(recovery.status, "completed");
  assert.deepEqual(recovery.recoveredToolCallIds, [failure.id]);
  assert.deepEqual(toolResults(requests[2]).map(({ content }) => content.split("\n")[0]), [
    "Tool status: failed", "Tool status: completed",
  ]);
});

test("a duplicate success from the same provider reply cannot hide its sibling's failure", async (t) => {
  const { outcome, entries } = await runFixture(t, [
    reply("Checking the same fixture twice.", shell(), shell()), finalReply,
  ], { native: shellReplies(failedExit, successfulExit) });
  assert.equal(outcome, "failed");
  const tools = entries[0].toolCalls;
  assert.deepEqual(tools.map(({ status }) => status), ["failed", "completed"]);
  assert.deepEqual(tools[1].recoveredToolCallIds ?? [], []);
});

const fixtureWrite = {
  name: "write_file",
  arguments: { path: "/fixture/workspace/notes.txt", content: "Proposed fixture note.\n" },
};

function writeStubs() {
  let proposal = 0;
  return {
    createWriteProposal: async (path, content) => ({
      id: `fixture-proposal-${++proposal}`, path, before: "Current fixture note.\n", after: content,
      existed: true, status: "Pending",
    }),
    rejectProposal: async () => true,
    approveProposal: async () => true,
    recordRejectionAudit: async () => true,
    writeFileContent: async (path, content) => ({ path, success: true, size_bytes: Buffer.byteLength(content) }),
  };
}

test("declining a write blocks the run and never executes that proposal", async (t) => {
  const { outcome, entries, bridge, requests } = await runFixture(t, [
    reply("Proposing a fixture note.", fixtureWrite), finalReply,
  ], { native: writeStubs(), decisions: [false] });
  assert.equal(outcome, "failed");
  const [declined] = entries[0].toolCalls;
  assert.equal(declined.status, "rejected");
  assert.match(toolResults(requests[1])[0].content, /tool status:\s*rejected\b/i);
  assert.equal(bridge.writeFileContent.mock.callCount(), 0);
});

test("a separate human approval can authorize a retry but cannot clear a prior write rejection", async (t) => {
  const { outcome, entries, approvals, bridge } = await runFixture(t, [
    reply("Proposing a fixture note.", fixtureWrite), reply("Proposing the same fixture note again.", fixtureWrite), finalReply,
  ], { native: writeStubs(), decisions: [false, true] });
  assert.equal(outcome, "failed");
  const [declined, approved] = entries.map(({ toolCalls }) => toolCalls[0]);
  assert.equal(declined.status, "rejected");
  assert.equal(approved.status, "completed");
  assert.deepEqual(approved.recoveredToolCallIds ?? [], []);
  assert.deepEqual(approvals.map(({ id, status }) => [id, status]), [
    [declined.id, "pending_approval"], [approved.id, "pending_approval"],
  ]);
  assert.notEqual(declined.proposalId, approved.proposalId);
  assert.deepEqual(bridge.rejectProposal.mock.calls.map((call) => call.arguments), [[declined.proposalId]]);
  assert.deepEqual(bridge.approveProposal.mock.calls.map((call) => call.arguments), [[approved.proposalId]]);
  assert.deepEqual(bridge.writeFileContent.mock.calls.map((call) => call.arguments.at(-1)), [approved.proposalId]);
});

for (const [scenario, tool, supportsTools] of [
  ["an unknown tool", { name: "fixture_unknown_tool", arguments: {} }, true],
  ["delegation without a resolver", { name: "delegate_task", arguments: { bot: "fixture", task: "Summarize the fixture." } }, true],
  ["a known tool on a tool-less model", shell(), false],
]) {
  test(`${scenario} fails the run without using the native bridge`, async (t) => {
    const { outcome, entries, requests } = await runFixture(t, [reply("Checking the fixture.", tool), finalReply], { supportsTools });
    assert.equal(outcome, "failed");
    const [call] = entries[0].toolCalls;
    assert.equal(call.name, tool.name);
    assert.equal(call.status, "failed");
    assert.match(call.result.error, /unavailable/i);
    assert.match(toolResults(requests[1])[0].content, /tool status:\s*failed\b/i);
  });
}

test("a provider error fails the run and leaves a visible error", async (t) => {
  const { outcome, entries } = await runFixture(t, [new Response("Fixture provider is unavailable.", { status: 503 })]);
  assert.equal(outcome, "failed");
  assert.match(entries[0].content, /503.*fixture provider is unavailable/i);
});

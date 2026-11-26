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

async function runFixture(t, replies, {
  native, decisions = [], supportsTools = true, sameTick = false, scope, modelOverrides,
  vaultOverrides, history = [], onUpdate, loop = new sources.agent.AgentLoop(),
} = {}) {
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
  const outcome = await loop.runTurn(
    threadId,
    [...history, { id: "fixture-user", threadId, timestamp, role: "user", content: "Check the fixture." }],
    bot,
    { ...model, supportsTools, ...modelOverrides },
    { ...vault, ...vaultOverrides },
    (update) => {
      entries = entries.map((entry) => entry.id === update.id ? structuredClone(update) : entry);
      onUpdate?.(structuredClone(update));
    },
    (entry) => { entries.push(structuredClone(entry)); },
    (tool, resolve) => {
      const approved = decisions[approvals.length];
      approvals.push(structuredClone(tool));
      assert.notEqual(approved, undefined, "Approval was not scripted for this action");
      if (typeof approved === "function") approved();
      else resolve(approved);
    },
    undefined,
    scope,
  );

  assert.equal(requests.length, replies.length, "Provider reply count");
  const endpoint = modelOverrides?.provider === "openai"
    ? "https://api.openai.com/v1/chat/completions"
    : "http://fixture.invalid/api/chat";
  assert.ok(requests.every(({ url }) => url === endpoint), "Only the expected endpoint is used by the fetch mock");
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

const workspaceScope = {
  workspaceId: "fixture-workspace",
  installationId: "fixture-installation",
  tools: [],
};
const handle = "opaque-fixture-run";
const path = fixtureWrite.arguments.path;
const read = { name: "read_file", arguments: { path, max_lines: 5 } };
const list = { name: "list_directory", arguments: { path: "/fixture/workspace" } };
function workspaceStubs() {
  return {
    startWorkspaceRun: async () => handle,
    endWorkspaceRun: async () => {},
  };
}
const callArguments = (mock) => mock.mock.calls.map((call) => call.arguments);
const workspaceProposal = async (_, filePath, content) => ({
  id: "write-proposal", path: filePath, before: "Current fixture note.", after: content, existed: true,
});

test("scoped dispatch reuses one handle for filesystem tools and delegation across rounds", async (t) => {
  const loop = new sources.agent.AgentLoop();
  const steps = [];
  const scope = { ...workspaceScope, tools: ["read_file", "list_directory", "write_file", "delegate_task"] };
  const delegate = { name: "delegate_task", arguments: { bot: "teammate", task: "Summarize the fixture." } };
  loop.delegateResolver = async (botRef, task, signal, actor) => {
    assert.equal(botRef, delegate.arguments.bot);
    assert.equal(task, delegate.arguments.task);
    assert.equal(signal.aborted, false);
    assert.deepEqual(actor, { handle, workspaceId: scope.workspaceId, installationId: scope.installationId });
    await sources.bridge.TauriBridge.verifyWorkspaceDelegate(actor.handle, "target-installation");
    steps.push("delegate");
    return { ok: true, botName: "Teammate", modelUsed: "Fixture model", reply: "Fixture summary." };
  };
  const { outcome, requests, entries, bridge } = await runFixture(t, [
    reply("Inspecting the workspace.", read, list), reply("Proposing a write.", fixtureWrite, delegate), finalReply,
  ], {
    loop, scope, decisions: [true],
    native: {
      startWorkspaceRun: async () => { steps.push("start"); return handle; },
      endWorkspaceRun: async () => { steps.push("end"); },
      workspaceReadFile: async () => {
        steps.push("read");
        return { content: "Current fixture note.", total_lines: 1, size_bytes: 21 };
      },
      workspaceListDirectory: async () => {
        steps.push("list");
        return [{ name: "notes.txt", is_dir: false, size: 21 }];
      },
      workspaceCreateWriteProposal: async (...args) => {
        steps.push("propose");
        return workspaceProposal(...args);
      },
      approveProposal: async () => { steps.push("approve"); return true; },
      workspaceWriteFile: async (_, filePath, content) => {
        steps.push("write");
        return { path: filePath, success: true, size_bytes: Buffer.byteLength(content) };
      },
      verifyWorkspaceDelegate: async () => { steps.push("verify"); },
    },
  });

  assert.equal(outcome, "completed");
  assert.equal(loop.isBusy(), false);
  assert.deepEqual(steps, ["start", "read", "list", "propose", "approve", "write", "verify", "delegate", "end"]);
  assert.deepEqual(callArguments(bridge.startWorkspaceRun), [[scope.workspaceId, scope.installationId]]);
  assert.deepEqual(callArguments(bridge.endWorkspaceRun), [[handle]]);
  assert.deepEqual(callArguments(bridge.workspaceReadFile), [[handle, path, 5]]);
  assert.deepEqual(callArguments(bridge.workspaceListDirectory), [[handle, list.arguments.path]]);
  assert.deepEqual(callArguments(bridge.workspaceCreateWriteProposal), [[handle, path, fixtureWrite.arguments.content]]);
  assert.deepEqual(callArguments(bridge.approveProposal), [["write-proposal"]]);
  assert.deepEqual(callArguments(bridge.workspaceWriteFile), [[handle, path, fixtureWrite.arguments.content, "write-proposal"]]);
  assert.deepEqual(callArguments(bridge.verifyWorkspaceDelegate), [[handle, "target-installation"]]);
  for (const { body } of requests) {
    assert.deepEqual(body.tools.map((tool) => tool.function.name).sort(), [...scope.tools].sort());
    assert.ok(!JSON.stringify(body).includes(handle), "Run handles are never sent to the provider");
  }
  assert.deepEqual(entries.flatMap((entry) => entry.toolCalls.map((tool) => tool.status)), Array(4).fill("completed"));
});

test("scoped dispatch rejects uninstalled, unknown, and shell tool calls", async (t) => {
  const denied = [
    list,
    shell(),
    { name: "fixture_unknown_tool", arguments: {} },
  ];
  const { outcome, requests, entries, bridge } = await runFixture(t, [reply("Checking.", ...denied), finalReply], {
    scope: { ...workspaceScope, tools: ["read_file", "execute_shell"] },
    native: workspaceStubs(),
  });
  assert.equal(outcome, "failed");
  assert.deepEqual(requests[0].body.tools.map((tool) => tool.function.name), ["read_file"]);
  assert.deepEqual(callArguments(bridge.endWorkspaceRun), [[handle]]);
  assert.equal(entries[0].toolCalls.length, denied.length);
  for (const tool of entries[0].toolCalls) {
    assert.equal(tool.status, "failed");
    assert.match(tool.result.error, /unavailable/i);
  }
  assert.equal(toolResults(requests[1]).length, denied.length);
});

for (const [description, options] of [
  ["a chat-only installation", { scope: workspaceScope }],
  ["a model without tool support", { scope: { ...workspaceScope, tools: ["read_file"] }, supportsTools: false }],
]) {
  test(`${description} omits scoped tool definitions and denies unsolicited calls`, async (t) => {
    const { outcome, requests, entries } = await runFixture(t, [reply("Checking.", read), finalReply], {
      ...options, native: workspaceStubs(),
    });
    assert.equal(outcome, "failed");
    assert.ok(requests.every(({ body }) => !("tools" in body)));
    assert.match(entries[0].toolCalls[0].result.error, /unavailable/i);
  });
}

for (const [description, modelOverrides] of [
  ["an ACP provider", { provider: "acp" }],
  ["a model marked as BYOP", { isByop: true }],
]) {
  test(`a scoped turn blocks ${description} before provider or native I/O`, async (t) => {
    const { outcome, entries } = await runFixture(t, [], { scope: workspaceScope, modelOverrides });
    assert.equal(outcome, "failed");
    assert.match(entries[0].content, /CLI agents.*cannot run as workspace bots/i);
  });
}

test("a provider failure closes the scoped run", async (t) => {
  const { outcome, entries, bridge } = await runFixture(t, [new Response("unavailable", { status: 503 })], {
    scope: workspaceScope, native: workspaceStubs(),
  });
  assert.equal(outcome, "failed");
  assert.match(entries[0].content, /503.*unavailable/i);
  assert.deepEqual(callArguments(bridge.endWorkspaceRun), [[handle]]);
});

test("a failed scoped startup neither streams nor falls back to an owner run", async (t) => {
  const { outcome, entries } = await runFixture(t, [], {
    scope: workspaceScope,
    native: { startWorkspaceRun: async () => { throw "Installation is no longer in this workspace."; } },
  });
  assert.equal(outcome, "failed");
  assert.match(entries[0].content, /installation is no longer in this workspace/i);
});

test("Stop during scoped startup closes the newly opened handle without streaming", async (t) => {
  const loop = new sources.agent.AgentLoop();
  const { outcome, bridge } = await runFixture(t, [], {
    loop, scope: workspaceScope,
    native: { ...workspaceStubs(), startWorkspaceRun: async () => { assert.ok(loop.abort()); return handle; } },
  });
  assert.equal(outcome, "cancelled");
  assert.deepEqual(callArguments(bridge.endWorkspaceRun), [[handle]]);
  assert.equal(loop.isBusy(), false);
});

test("Stop during scoped write approval cancels the proposal, closes once, and never writes", async (t) => {
  const loop = new sources.agent.AgentLoop();
  const { outcome, entries, bridge } = await runFixture(t, [reply("Proposing.", fixtureWrite)], {
    loop,
    scope: { ...workspaceScope, tools: ["write_file"] },
    decisions: [() => assert.ok(loop.abort())],
    native: {
      ...workspaceStubs(),
      workspaceCreateWriteProposal: workspaceProposal,
      cancelProposal: async () => true,
      recordRejectionAudit: async () => true,
    },
  });
  assert.equal(outcome, "cancelled");
  assert.equal(entries[0].toolCalls[0].status, "rejected");
  assert.deepEqual(callArguments(bridge.cancelProposal), [["write-proposal"]]);
  assert.deepEqual(callArguments(bridge.endWorkspaceRun), [[handle]]);
  assert.equal(loop.isBusy(), false);
});

test("native approval failure leaves the reviewed diff but never applies the scoped write", async (t) => {
  const { outcome, entries, bridge } = await runFixture(t, [reply("Proposing.", fixtureWrite), finalReply], {
    scope: { ...workspaceScope, tools: ["write_file"] },
    decisions: [true],
    native: {
      ...workspaceStubs(),
      workspaceCreateWriteProposal: workspaceProposal,
      approveProposal: async () => false,
      cancelProposal: async () => true,
    },
  });
  assert.equal(outcome, "failed");
  const [tool] = entries[0].toolCalls;
  assert.equal(tool.status, "failed");
  assert.match(tool.result.error, /could not be approved/i);
  assert.equal(tool.result.diff.after, fixtureWrite.arguments.content);
  assert.deepEqual(callArguments(bridge.cancelProposal), [["write-proposal"]]);
});

test("scoped bridge uses native handle arguments and fails closed outside Tauri", async (t) => {
  const bridge = sources.bridge.TauriBridge;
  const { workspaceId, installationId } = workspaceScope;
  await assert.rejects(bridge.startWorkspaceRun(workspaceId, installationId), /desktop app/i);

  const calls = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __TAURI_INTERNALS__: { invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === "start_workspace_run") return handle;
      if (command === "verify_workspace_delegate") return args.targetInstallationId === "allowed";
      return true;
    } } },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else delete globalThis.window;
  });

  assert.equal(await bridge.startWorkspaceRun(workspaceId, installationId), handle);
  await bridge.workspaceReadFile(handle, path, 5);
  await bridge.workspaceListDirectory(handle, path);
  await bridge.workspaceCreateWriteProposal(handle, path, "fixture");
  await bridge.workspaceWriteFile(handle, path, "fixture", "proposal");
  await bridge.verifyWorkspaceDelegate(handle, "allowed");
  await assert.rejects(bridge.verifyWorkspaceDelegate(handle, "denied"), /not allowed/i);
  await bridge.endWorkspaceRun(handle);
  assert.deepEqual(calls, [
    ["start_workspace_run", { workspaceId, installationId }],
    ["workspace_read_file", { handle, path, maxLines: 5 }],
    ["workspace_list_directory", { handle, path }],
    ["workspace_create_write_proposal", { handle, path, content: "fixture" }],
    ["workspace_write_file", { handle, path, content: "fixture", proposalId: "proposal" }],
    ["verify_workspace_delegate", { handle, targetInstallationId: "allowed" }],
    ["verify_workspace_delegate", { handle, targetInstallationId: "denied" }],
    ["end_workspace_run", { handle }],
  ]);
});

test("a scoped turn sends only historical prose, then receives its own tool results", async (t) => {
  const history = [
    { role: "user", content: "Earlier fixture question." },
    {
      role: "assistant",
      content: "Earlier fixture answer.",
      toolCalls: [{
        id: "historical-tool-id", name: "read_file", status: "completed",
        arguments: { path: "/earlier/private-input.txt" }, result: { output: "EARLIER_PRIVATE_RESULT" },
      }],
    },
    { role: "assistant", content: "", toolCalls: [{ id: "historical-tool-only", name: "list_directory" }] },
  ];
  const { outcome, requests } = await runFixture(t, [reply("Checking.", read), finalReply], {
    history,
    scope: { ...workspaceScope, tools: ["read_file"] },
    native: { ...workspaceStubs(), workspaceReadFile: async () => ({ content: "Active fixture result." }) },
  });
  assert.equal(outcome, "completed");
  for (const { body } of requests) {
    assert.deepEqual(body.messages.slice(1, 3), [
      { role: "user", content: "Earlier fixture question." },
      { role: "assistant", content: "Earlier fixture answer." },
    ]);
    assert.doesNotMatch(JSON.stringify(body.messages), /EARLIER_PRIVATE_RESULT|private-input|historical-tool/);
  }
  assert.deepEqual(toolResults(requests[0]), []);
  assert.match(toolResults(requests[1])[0].content, /Active fixture result\./);
});

test("duplicate provider IDs leave queued tools nonactionable and bind each approval to its own proposal", async (t) => {
  const providerId = "duplicate-fixture-id";
  const writes = [fixtureWrite, { ...fixtureWrite, arguments: { ...fixtureWrite.arguments, path: `${path}.other` } }];
  const sse = (...frames) => new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""));
  const updates = [];
  const { outcome, approvals, requests, bridge } = await runFixture(t, [
    sse({ choices: [{ delta: { tool_calls: writes.map((tool, index) => ({
      index, id: providerId, function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
    })) }, finish_reason: "tool_calls" }] }),
    sse({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }),
  ], {
    modelOverrides: { provider: "openai" },
    vaultOverrides: { openaiApiKey: "fixture-key" },
    decisions: [true, true],
    native: writeStubs(),
    onUpdate: ({ toolCalls }) => { if (toolCalls.length === 2) updates.push(toolCalls); },
  });
  assert.equal(outcome, "completed");
  assert.ok(updates.some((calls) => calls.every(({ status }) => status === "queued")));
  assert.ok(updates.some(([first, second]) => first.status === "pending_approval" &&
    second.status === "queued" && second.proposalId === undefined));
  assert.notEqual(approvals[0].id, approvals[1].id);
  assert.deepEqual(approvals.map((tool) => tool.providerCallId), [providerId, providerId]);
  assert.deepEqual(callArguments(bridge.approveProposal), approvals.map((tool) => [tool.proposalId]));
  const wireIds = requests[1].body.messages.find((message) => message.tool_calls).tool_calls.map(({ id }) => id);
  assert.equal(wireIds[0], providerId);
  assert.notEqual(wireIds[0], wireIds[1]);
  assert.deepEqual(toolResults(requests[1]).map(({ tool_call_id }) => tool_call_id), wireIds);
});

test("an Ollama length stop preserves partial text but never emits or runs a tool", async (t) => {
  const truncated = new Response([
    { message: { content: "Partial fixture reply.", tool_calls: [{ function: fixtureWrite }] } },
    { done: true, done_reason: "length" },
  ].map((frame) => `${JSON.stringify(frame)}\n`).join(""));
  const updates = [];
  const { outcome, entries, bridge } = await runFixture(t, [truncated], {
    scope: { ...workspaceScope, tools: ["write_file"] },
    native: workspaceStubs(),
    onUpdate: (entry) => updates.push(entry),
  });
  assert.equal(outcome, "failed");
  assert.match(entries[0].content, /Partial fixture reply\..*done_reason: length/s);
  assert.ok(updates.every((entry) => entry.toolCalls.length === 0));
  assert.deepEqual(callArguments(bridge.endWorkspaceRun), [[handle]]);
});

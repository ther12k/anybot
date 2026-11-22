import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSources, stubIO } from "./fixtures/runtime.mjs";

const sources = loadSources({
  stream: "/src/services/ai/streamClient.ts",
  models: "/src/services/ai/models.ts",
  bridge: "/src/services/tauri/bridge.ts",
});

const acpModels = () => sources.models.AVAILABLE_MODELS.filter(({ provider }) => provider === "acp");

function stubCli(t, ...events) {
  return stubIO(t, sources.bridge.TauriBridge, {
    native: {
      runAcpPrompt: async (sessionId, _engine, _prompt, _cwd, emit) => {
        for (const event of events) emit({ session_id: sessionId, ...event });
        emit({ session_id: sessionId, event_type: "finished" });
        return true;
      },
    },
  });
}

test("the ACP bridge prompt carries earlier facts and exactly one latest request", async (t) => {
  const model = acpModels()[0];
  const bridge = stubCli(t);
  const earlierFact = "The fixture sample's tag is Résumé-R4.";
  const latestRequest = "Which tag did I give in the first message?\nAnswer with the tag only.";
  const toolOutput = "Unrelated fixture tool output.";
  await sources.stream.streamChatCompletion(model, {}, [
    { role: "user", content: earlierFact },
    { role: "assistant", content: "I noted that tag." },
    { role: "tool", content: toolOutput },
    { role: "user", content: latestRequest },
  ], "Answer briefly.", {});

  assert.equal(bridge.runAcpPrompt.mock.callCount(), 1);
  const [, engine, prompt] = bridge.runAcpPrompt.mock.calls[0].arguments;
  assert.equal(engine, model.agentEngine);
  assert.ok(prompt.includes("Answer briefly."));
  assert.ok(prompt.includes(earlierFact));
  assert.ok(prompt.includes("I noted that tag."));
  assert.ok(!prompt.includes(toolOutput));
  assert.equal(prompt.split(latestRequest).length - 1, 1);
  assert.ok(prompt.indexOf(earlierFact) < prompt.indexOf(latestRequest));
});

test("ACP keeps recent context within the history budget without shortening the latest request", async (t) => {
  const bridge = stubCli(t);
  const history = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Fixture record ${index}. ${"detail ".repeat(600)}`,
  }));
  const latestRequest = `Summarize these fixture records. ${"Note. ".repeat(500)}`;
  await sources.stream.streamChatCompletion(acpModels()[0], {}, [
    ...history, { role: "user", content: latestRequest },
  ], "", {});

  const [, , prompt] = bridge.runAcpPrompt.mock.calls[0].arguments;
  assert.ok(prompt.length <= 20_000 + latestRequest.length + 100, "History is bounded separately from the request");
  assert.ok(prompt.includes("Fixture record 29."));
  assert.ok(!prompt.includes("Fixture record 0."));
  assert.ok(prompt.includes(latestRequest));
});

test("CLI tool metadata is not replayed as an AnyBot tool action", async (t) => {
  stubCli(t,
    { event_type: "content", text: "This is a fixture response." },
    { event_type: "tool_call", tool_name: "read_file", tool_args: JSON.stringify({ path: "/fixture/notes.txt" }) },
  );
  const events = [];
  await sources.stream.streamChatCompletion(acpModels()[0], {}, [
    { role: "user", content: "Summarize the fixture." },
  ], "", {
    onContentDelta: (text) => events.push(["content", text]),
    onToolCall: (tool) => events.push(["tool", tool.name]),
    onFinished: () => events.push(["finished"]),
  });
  assert.deepEqual(events, [["content", "This is a fixture response."], ["finished"]]);
});

test("every available ACP model refuses tool-less delegation before calling the bridge", async (t) => {
  const models = acpModels();
  assert.ok(models.length, "Expected ACP models in the roster");
  for (const model of models) {
    await t.test(model.id, async (fixture) => {
      const bridge = stubCli(fixture);
      const events = [];
      await assert.rejects(sources.stream.streamChatCompletion(model, {}, [
        { role: "user", content: "Summarize the fixture." },
      ], "", {
        onContentDelta: () => events.push("content"),
        onFinished: () => events.push("finished"),
        onError: (error) => events.push(error),
      }, undefined, undefined, { includeTools: false }), /tool-less delegation is not supported/i);
      assert.equal(bridge.runAcpPrompt.mock.callCount(), 0);
      assert.equal(events.length, 1);
      assert.ok(events[0] instanceof Error);
    });
  }
});

test("tool-less delegation can complete through a managed model without advertising tools", async (t) => {
  const requests = [];
  const model = sources.models.AVAILABLE_MODELS.find((candidate) => candidate.provider === "ollama" && candidate.supportsTools);
  assert.ok(model, "Expected an Ollama model that normally advertises tools");
  stubIO(t, sources.bridge.TauriBridge, {
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response('{"message":{"content":"Fixture summary."},"done":true}\n');
    },
  });
  const content = [];
  await sources.stream.streamChatCompletion(model, { ollamaBaseUrl: "http://fixture.invalid" }, [
    { role: "user", content: "Summarize the fixture." },
  ], "", {
    onContentDelta: (text) => content.push(text),
  }, undefined, undefined, { includeTools: false });
  assert.equal(requests.length, 1);
  assert.ok(!("tools" in requests[0]));
  assert.deepEqual(content, ["Fixture summary."]);
});

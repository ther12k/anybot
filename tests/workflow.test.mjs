import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSources } from "./fixtures/runtime.mjs";

const sources = loadSources({
  runner: "/src/services/workflow.ts",
  defaults: "/src/data/defaultWorkflows.ts",
});

function workflow(steps, id = "fixture-workflow") {
  return { id, name: "Fixture workflow", description: "Summarize fixture notes", icon: "F", steps };
}

function start(workflow, { startIndex = 0, reply = async () => "completed", shouldStop = () => false } = {}) {
  const prompts = [];
  const progress = [];
  const result = sources.runner.runWorkflowSteps(workflow, startIndex, {
    runPrompt: (prompt) => {
      prompts.push(prompt);
      return reply(prompt);
    },
    onStep: (step) => progress.push(step),
    shouldStop,
  });
  return { result, prompts, progress };
}

const prompts = ["Read the fixture notes.", "Draft the fixture summary.", "Polish the fixture summary."];

test("runs completed prompt steps in order, reporting one-based progress", async () => {
  const run = start(workflow(prompts));
  assert.deepEqual(await run.result, { state: "completed", step: 3 });
  assert.deepEqual(run.prompts, prompts);
  assert.deepEqual(run.progress, [1, 2, 3]);
});

for (const [outcome, state] of [["failed", "failed"], ["cancelled", "cancelled"], [null, "failed"]]) {
  test(`a ${outcome === null ? "refused (null)" : outcome} prompt blocks every dependent step`, async () => {
    const run = start(workflow(prompts), { reply: async (prompt) => prompt === prompts[0] ? "completed" : outcome });
    assert.deepEqual(await run.result, { state, step: 2 });
    assert.deepEqual(run.prompts, prompts.slice(0, 2));
    assert.deepEqual(run.progress, [1, 2]);
  });
}

test("Stop before dispatch cancels a workflow without sending the first prompt", async () => {
  const run = start(workflow(prompts), { shouldStop: () => true });
  assert.deepEqual(await run.result, { state: "cancelled", step: 0 });
  assert.deepEqual(run.prompts, []);
  assert.deepEqual(run.progress, []);
});

test("Stop during an in-flight prompt blocks a later gate even if the prompt completes", { timeout: 5_000 }, async () => {
  let stopped = false;
  let markStarted;
  let finishPrompt;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const firstResult = new Promise((resolve) => { finishPrompt = resolve; });
  const run = start(workflow([prompts[0], { kind: "human_input" }, prompts[1]]), {
    reply: () => { markStarted(); return firstResult; },
    shouldStop: () => stopped,
  });
  await started;
  stopped = true;
  finishPrompt("completed");
  assert.deepEqual(await run.result, { state: "cancelled", step: 1 });
  assert.deepEqual(run.prompts, [prompts[0]]);
});

function throughStorage(pendingWorkflow) {
  return JSON.parse(JSON.stringify({ id: "fixture-thread", pendingWorkflow })).pendingWorkflow;
}

for (const [kind, state] of [["human_input", "awaiting_input"], ["approval", "awaiting_approval"]]) {
  test(`pauses at the ${kind} gate without sending its dependent prompt and restores it from JSON`, async () => {
    const gate = { kind };
    const plan = workflow([prompts[0], gate, prompts[1]]);
    const run = start(plan);
    const paused = await run.result;
    assert.deepEqual(paused, { state, step: 2, nextStep: 2, gate });
    assert.deepEqual(run.prompts, [prompts[0]]);

    const marker = throughStorage({ workflowId: plan.id, nextStep: paused.nextStep, kind });
    const restored = sources.runner.getWorkflowPause([plan], marker);
    assert.deepEqual(restored, { workflow: plan, gate, nextStep: 2 });

    const resume = start(restored.workflow, { startIndex: restored.nextStep });
    assert.deepEqual(await resume.result, { state: "completed", step: 3 });
    assert.deepEqual(resume.prompts, [prompts[1]]);
    assert.deepEqual(resume.progress, [3]);
  });
}

test("restores a legacy marker with no kind when its step is a human-input gate", () => {
  const gate = { kind: "human_input" };
  const plan = workflow([prompts[0], gate, prompts[1]]);
  assert.deepEqual(sources.runner.getWorkflowPause([plan], throughStorage({ workflowId: plan.id, nextStep: 2 })), {
    workflow: plan, gate, nextStep: 2,
  });
});

test("ignores malformed or stale JSON pause markers rather than resuming a prompt", () => {
  const plan = workflow([prompts[0], { kind: "approval" }, prompts[1]]);
  const valid = { workflowId: plan.id, nextStep: 2, kind: "approval" };
  for (const invalid of [
    undefined, null, "wrong shape", {},
    { ...valid, workflowId: "missing-workflow" },
    { ...valid, nextStep: undefined },
    { ...valid, nextStep: 0 },
    { ...valid, nextStep: -1 },
    { ...valid, nextStep: 1 }, // Refers to a prompt, not a gate.
    { ...valid, nextStep: "2" },
    { ...valid, nextStep: 2.5 },
    { ...valid, nextStep: plan.steps.length + 1 },
    { ...valid, kind: "human_input" },
    { ...valid, kind: "unknown" },
  ]) {
    const marker = throughStorage(invalid);
    assert.equal(sources.runner.getWorkflowPause([plan], marker), null, `Marker ${JSON.stringify(marker)}`);
  }
});

test("an empty workflow or out-of-range start cannot send a prompt", async () => {
  for (const [steps, startIndex] of [[[], 0], [prompts, -1], [prompts, 1.5], [prompts, prompts.length + 1]]) {
    const run = start(workflow(steps), { startIndex });
    assert.deepEqual(await run.result, { state: "failed", step: 0 });
    assert.deepEqual(run.prompts, []);
  }
});

test("replaces saved Morning and README seeds but leaves custom workflows intact", async () => {
  const oldMorning = workflow(["Ask what is on my plate.", "Plan the day."], "wf-morning-brief");
  const oldReadme = workflow(["Read the fixture README.", "Wait for my confirmation.", "Draft the changes."], "wf-readme-refresh");
  const custom = { ...workflow(["Collect fixture picks.", { kind: "human_input" }]), isCustom: true };
  const saved = JSON.parse(JSON.stringify([oldMorning, oldReadme, custom]));
  const migrated = sources.runner.reconcileWorkflows(saved);

  assert.deepEqual(migrated.find(({ id }) => id === custom.id), custom);
  for (const [id, gateIndex, kind, state] of [
    [oldMorning.id, 1, "human_input", "awaiting_input"],
    [oldReadme.id, 2, "approval", "awaiting_approval"],
  ]) {
    const [plan, ...duplicates] = migrated.filter((candidate) => candidate.id === id);
    assert.equal(duplicates.length, 0);
    assert.deepEqual(plan, sources.defaults.DEFAULT_WORKFLOWS.find((seed) => seed.id === id));
    const run = start(plan);
    assert.deepEqual(await run.result, { state, step: gateIndex + 1, nextStep: gateIndex + 1, gate: { kind } });
    assert.deepEqual(run.prompts, plan.steps.slice(0, gateIndex));
    assert.equal(typeof plan.steps[gateIndex + 1], "string", "A dependent prompt remains after the new gate");
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { loadSources } from "./fixtures/runtime.mjs";

const sources = loadSources({ workspace: "/src/services/workspace.ts" });
const bot = (id) => ({ id });
const thread = (patch = {}) => ({ id: "chat", botId: "general", title: "History", createdAt: 1, updatedAt: 2, ...patch });
const installation = (id, workspace, persona, tools = []) => ({ id, workspace_id: workspace, template_id: "tmpl_chat", persona_id: persona, tools });

test("migration requests installations without grants only for known legacy personas", () => {
  const { missingLegacyPersonas } = sources.workspace;
  const threads = [thread(), thread({ isRoom: true, participantBotIds: ["general", "research", "missing"] }),
    thread({ botId: "code", workspaceId: "existing" })];
  const requests = missingLegacyPersonas(threads, [bot("general"), bot("research"), bot("code")],
    [installation("gen", "default", "general")]);
  assert.deepEqual(requests, [{ persona_id: "research", template_id: "tmpl_developer", tools: [] }]);
});

test("migration retains chat IDs and workflow checkpoints without touching workspace history", () => {
  const { migrateLegacyThreads } = sources.workspace;
  const old = thread({ pendingWorkflow: { workflowId: "wf-readme-refresh", nextStep: 3 } });
  const room = thread({ id: "room", isRoom: true, participantBotIds: ["general", "research", "research", "missing"] });
  const current = thread({ workspaceId: "other", installationId: "other-general" });
  const bots = [installation("gen", "default", "general"), installation("res", "default", "research"),
    installation("other-general", "other", "general")];
  const [migrated, migratedRoom, existing] = migrateLegacyThreads([old, room, current], "default", bots);
  assert.deepEqual(migrated, { ...old, workspaceId: "default", installationId: "gen" });
  assert.deepEqual(migratedRoom, { ...room, workspaceId: "default", installationId: "gen", participantInstallationIds: ["gen", "res"] });
  assert.equal(existing, current);
  assert.equal(migrateLegacyThreads([migrated], "other", bots)[0], migrated);
});

test("uninstalled or foreign installations cannot resume the primary or join a room by persona", () => {
  const { primaryInstallation, roomInstallations } = sources.workspace;
  const room = thread({ workspaceId: "default", installationId: "original", isRoom: true,
    participantInstallationIds: ["original", "foreign", "member", "member"] });
  const bots = [installation("replacement", "default", "general"), installation("foreign", "other", "general"),
    installation("member", "default", "research")];
  assert.equal(primaryInstallation(room, bots), undefined);
  assert.deepEqual(roomInstallations(room, bots), [bots[2]]);
  assert.deepEqual(roomInstallations({ ...room, participantInstallationIds: undefined }, bots), []);
});

test("workflows requiring shell or a missing file tool are unavailable in workspaces", () => {
  const { workspaceToolsAllowWorkflow } = sources.workspace;
  const workflow = (id) => ({ id, toolsRequired: true });
  assert.equal(workspaceToolsAllowWorkflow(workflow("wf-repo-health"), ["execute_shell"]), false);
  assert.equal(workspaceToolsAllowWorkflow(workflow("wf-readme-refresh"), ["read_file"]), false);
  assert.equal(workspaceToolsAllowWorkflow(workflow("wf-readme-refresh"), ["read_file", "write_file"]), true);
  assert.equal(workspaceToolsAllowWorkflow({ id: "wf-morning-brief" }, []), true);
});

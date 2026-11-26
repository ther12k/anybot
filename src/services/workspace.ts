import { invoke } from "@tauri-apps/api/core";
import type { BotPersona, BotWorkflow, Thread } from "../types";
import type {
  BotInstallation, BotInstallationRequest, WorkspaceAccess, WorkspaceRegistry, WorkspaceTool,
} from "../types/workspace";

export const WorkspaceBridge = {
  ensureDefault: () => invoke<WorkspaceRegistry>("ensure_default_workspace"),
  createWorkspace: (name: string) => invoke<WorkspaceRegistry>("create_workspace", { name, access: "read" }),
  addResource: (workspaceId: string, folder: string, access: WorkspaceAccess) =>
    invoke<WorkspaceRegistry>("add_workspace_resource", { workspaceId, folder, access }),
  removeResource: (workspaceId: string, resourceId: string) =>
    invoke<WorkspaceRegistry>("remove_workspace_resource", { workspaceId, resourceId }),
  installBots: (workspaceId: string, bots: BotInstallationRequest[]) =>
    invoke<WorkspaceRegistry>("install_bots", { workspaceId, bots }),
  updateBotTools: (installationId: string, tools: WorkspaceTool[]) =>
    invoke<WorkspaceRegistry>("update_bot_tools", { installationId, tools }),
  removeBot: (installationId: string) => invoke<WorkspaceRegistry>("remove_bot", { installationId }),
};

export function installationsIn(registry: WorkspaceRegistry | null, workspaceId: string | undefined) {
  return registry?.installations.filter((installation) => installation.workspace_id === workspaceId) ?? [];
}

const legacyPersonaIds = (thread: Thread) => [thread.botId,
  ...(thread.isRoom && Array.isArray(thread.participantBotIds) ? thread.participantBotIds : [])];

export function missingLegacyPersonas(
  threads: Thread[], bots: BotPersona[], installations: BotInstallation[],
): BotInstallationRequest[] {
  const known = new Set(bots.map((bot) => bot.id));
  const installed = new Set(installations.map((installation) => installation.persona_id));
  const ids = new Set(threads.filter((thread) => thread.workspaceId === undefined).flatMap(legacyPersonaIds));
  // Preserve the option to explicitly configure file tools later without
  // replacing the installation that owns this history. Start with no grants.
  return [...ids].filter((id) => typeof id === "string" && /^[a-zA-Z0-9._-]{1,64}$/.test(id) && known.has(id) && !installed.has(id))
    .map((persona_id) => ({ persona_id, template_id: "tmpl_developer", tools: [] }));
}

/** Attach legacy history once. A removed installation must not be silently
 * replaced by a new installation of the same persona. */
export function migrateLegacyThreads(threads: Thread[], workspaceId: string, installations: BotInstallation[]): Thread[] {
  const byPersona = new Map(installations.filter((item) => item.workspace_id === workspaceId)
    .map((item) => [item.persona_id, item.id]));
  return threads.map((thread) => {
    if (thread.workspaceId !== undefined) return thread;
    return {
      ...thread,
      workspaceId,
      installationId: byPersona.get(thread.botId),
      ...(thread.isRoom ? {
        participantInstallationIds: [...new Set(legacyPersonaIds(thread).flatMap((id) => byPersona.get(id) ?? []))],
      } : {}),
    };
  });
}

export function primaryInstallation(thread: Thread, installations: BotInstallation[]) {
  return installations.find((item) => item.workspace_id === thread.workspaceId &&
    item.id === thread.installationId && item.persona_id === thread.botId);
}

export function roomInstallations(thread: Thread, installations: BotInstallation[]) {
  if (!thread.isRoom || !Array.isArray(thread.participantInstallationIds)) return [];
  return [...new Set(thread.participantInstallationIds)].flatMap((id) => {
    const member = installations.find((item) => item.workspace_id === thread.workspaceId && item.id === id);
    return member ? [member] : [];
  });
}

const workflowTools = new Map<string, WorkspaceTool[]>([
  ["wf-repo-health", ["execute_shell"]],
  ["wf-code-review", ["execute_shell", "read_file"]],
  ["wf-readme-refresh", ["read_file", "write_file"]],
  ["wf-security-audit", ["list_directory", "read_file"]],
]);

export function workspaceToolsAllowWorkflow(workflow: BotWorkflow, tools: readonly WorkspaceTool[]) {
  if (!workflow.toolsRequired) return true;
  const requirements = workflow.isCustom ? undefined : workflowTools.get(workflow.id);
  return !!requirements?.every((tool) => tool !== "execute_shell" && tools.includes(tool));
}

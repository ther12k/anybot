export type WorkspaceTool = "read_file" | "list_directory" | "write_file" | "execute_shell" | "delegate_task";
export type WorkspaceAccess = "read" | "read_write";

export interface WorkspaceResource {
  id: string;
  path: string;
  access: WorkspaceAccess;
}

export interface Workspace {
  id: string;
  name: string;
  resources: WorkspaceResource[];
  created_at: number;
}

export interface BotInstallation {
  id: string;
  workspace_id: string;
  template_id: string;
  persona_id: string;
  tools: WorkspaceTool[];
}

export interface BotInstallationRequest {
  template_id: string;
  persona_id: string;
  tools?: WorkspaceTool[];
}

export interface BotTemplate {
  id: string;
  version: number;
  name: string;
  description: string;
  capabilities: WorkspaceTool[];
}

export interface WorkspaceRegistry {
  version: number;
  workspaces: Workspace[];
  installations: BotInstallation[];
  templates: BotTemplate[];
}

import { CommandSafetyResult } from "../../types";

/**
 * A standing grant ("Always allow" answer). Legacy grants are plain command
 * strings (workspace-agnostic); new grants are scoped to the working
 * directory they were approved in.
 */
export type StandingGrant =
  | string
  | { command: string; cwd?: string };

// Check if running inside Tauri webview
export const isTauriEnvironment = (): boolean => {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
};

// Safe invoke helper
async function safeInvoke<T>(cmd: string, args: Record<string, any> = {}): Promise<T> {
  if (isTauriEnvironment()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  
  // Browser dev mock fallback
  console.warn(`[Tauri Mock] invoke("${cmd}")`, args);
  if (cmd === "get_system_info") {
    return {
      os: "linux",
      arch: "x86_64",
      username: "user",
      cwd: "/home/user/workspace",
      home_dir: "/home/user",
    } as unknown as T;
  }
  if (cmd === "check_shell_safety") {
    return {
      command: args.command,
      tier: args.command.startsWith("ls") ? "Safe" : "Mutative",
      requires_confirmation: !args.command.startsWith("ls"),
      reason: "Mock safety evaluation",
      standing_grant: false,
    } as unknown as T;
  }
  if (cmd === "load_standing_grants") {
    return (JSON.parse(localStorage.getItem("anybot_grants") || "[]")) as unknown as T;
  }
  if (cmd === "save_standing_grants") {
    localStorage.setItem("anybot_grants", JSON.stringify(args.grants || []));
    return true as unknown as T;
  }
  if (cmd === "audit_event") {
    console.info("[audit]", args.event);
    return true as unknown as T;
  }
  if (cmd === "execute_shell_command") {
    return {
      stdout: `[Mock output for: ${args.command}]\nTotal files: 4\nStatus: OK`,
      stderr: "",
      exit_code: 0,
      success: true,
      execution_time_ms: 120,
    } as unknown as T;
  }
  if (cmd === "load_vault_config") {
    return (localStorage.getItem("anybot_vault") || "{}") as unknown as T;
  }
  if (cmd === "save_vault_config") {
    localStorage.setItem("anybot_vault", args.jsonData);
    return true as unknown as T;
  }
  if (cmd === "read_file_content") {
    return {
      content: `// Mock content of ${args.path}\nconsole.log("Hello from AnyBot");`,
      total_lines: 2,
      size_bytes: 48,
    } as unknown as T;
  }
  if (cmd === "write_file_content") {
    return {
      path: args.path,
      success: true,
      size_bytes: args.content.length,
    } as unknown as T;
  }
  if (cmd === "list_dir_entries") {
    return [
      { name: "src", path: "/workspace/src", is_dir: true, is_file: false, size: 0 },
      { name: "package.json", path: "/workspace/package.json", is_dir: false, is_file: true, size: 1024 },
    ] as unknown as T;
  }
  return null as unknown as T;
}

export const TauriBridge = {
  checkShellSafety: async (command: string, cwd?: string): Promise<CommandSafetyResult> => {
    return safeInvoke<CommandSafetyResult>("check_shell_safety", { command, cwd });
  },

  executeShellCommand: async (
    command: string,
    cwd?: string,
    timeoutSecs: number = 60,
    callId?: string,
    decision?: string
  ): Promise<{
    stdout: string;
    stderr: string;
    exit_code: number;
    success: boolean;
    execution_time_ms: number;
  }> => {
    return safeInvoke("execute_shell_command", {
      command,
      cwd,
      timeoutSecs,
      callId,
      decision,
    });
  },

  /** Kill a running shell execution (process group) by its call id. */
  killShellCommand: async (callId: string): Promise<boolean> => {
    return safeInvoke("kill_shell_command", { callId });
  },

  /** Standing grants ("Always allow" answers), persisted as JSON. */
  loadStandingGrants: async (): Promise<StandingGrant[]> => {
    const raw = await safeInvoke<StandingGrant[]>("load_standing_grants");
    return Array.isArray(raw) ? raw : [];
  },

  saveStandingGrants: async (grants: StandingGrant[]): Promise<boolean> => {
    return safeInvoke("save_standing_grants", { grants });
  },

  /** Record a governance event that never reaches execution (rejections). */
  auditEvent: async (event: Record<string, unknown>): Promise<boolean> => {
    return safeInvoke("audit_event", { event: JSON.stringify(event) });
  },

  readFileContent: async (
    path: string,
    maxLines?: number
  ): Promise<{ content: string; total_lines: number; size_bytes: number }> => {
    return safeInvoke("read_file_content", { path, maxLines });
  },

  writeFileContent: async (
    path: string,
    content: string,
    decision?: string
  ): Promise<{ path: string; success: boolean; size_bytes: number }> => {
    return safeInvoke("write_file_content", { path, content, decision });
  },

  listDirEntries: async (
    path: string
  ): Promise<Array<{ name: string; path: string; is_dir: boolean; is_file: boolean; size: number }>> => {
    return safeInvoke("list_dir_entries", { path });
  },

  getSystemInfo: async (): Promise<{
    os: string;
    arch: string;
    username: string;
    cwd: string;
    home_dir: string;
  }> => {
    return safeInvoke("get_system_info");
  },

  loadVaultConfig: async (): Promise<string> => {
    return safeInvoke("load_vault_config");
  },

  saveVaultConfig: async (jsonData: string): Promise<boolean> => {
    return safeInvoke("save_vault_config", { jsonData });
  },
};

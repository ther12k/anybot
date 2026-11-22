export type Role = "user" | "assistant" | "system" | "tool";

export type AIProvider = "anthropic" | "openai" | "ollama" | "grok" | "acp";

export interface AIModel {
  id: string;
  name: string;
  provider: AIProvider;
  contextWindow: number;
  supportsThinking: boolean;
  supportsTools: boolean;
  /** True for subscription/plan models (zero token cost) via local CLI or ACP */
  isByop?: boolean;
  /** Target agent CLI engine */
  agentEngine?: "claude" | "codex" | "opencode" | "zcode" | "agy" | "custom";
}

export interface DetectedAgentCli {
  engine: string;
  name: string;
  binary: string;
  path?: string | null;
  is_installed: boolean;
  version?: string | null;
  protocol: string;
}

export type CommandSafetyTier = "Safe" | "Mutative" | "Dangerous" | "Denied";

export interface CommandSafetyResult {
  command: string;
  tier: CommandSafetyTier;
  requires_confirmation: boolean;
  reason: string;
  /** Exact standing grant ("Always allow") matched; deny rules ran first. */
  standing_grant: boolean;
}

export interface ToolCallItem {
  id: string;
  name: "execute_shell" | "read_file" | "write_file" | "list_directory" | "delegate_task";
  arguments: Record<string, any>;
  status: "pending_approval" | "running" | "completed" | "failed" | "rejected";
  safetyTier?: CommandSafetyTier;
  safetyReason?: string;
  /** Immutable native proposal token issued by the Rust backend. */
  proposalId?: string;
  /** Failed attempts resolved by this successful retry. */
  recoveredToolCallIds?: string[];
  result?: {
    output?: string;
    error?: string;
    /** Pre-write proposal: prepared BEFORE approval, not after the write. */
    diff?: { before: string; after: string; path: string; existed?: boolean };
    exitCode?: number;
    executionTimeMs?: number;
  };
}

export interface TranscriptEntry {
  id: string;
  threadId: string;
  role: Role;
  content: string;
  /** Persona that authored this assistant entry (Team Rooms attribution). */
  authorBotId?: string;
  thinking?: string;
  isThinkingActive?: boolean;
  thinkingDurationMs?: number;
  toolCalls?: ToolCallItem[];
  timestamp: number;
}

export type BotCategory = "all" | "general" | "code" | "research" | "productivity" | "writing" | "fun";

export interface BotPromptSuggestion {
  title: string;
  subtitle: string;
  prompt: string;
  icon?: string;
  /** True when the task needs shell/file tools; hidden on chat-only models. */
  toolsRequired?: boolean;
}

export type WorkflowGate = { kind: "human_input" } | { kind: "approval" };
export type WorkflowStep = string | WorkflowGate;

/** A repeatable task chain of agent prompts and human checkpoints. */
export interface BotWorkflow {
  id: string;
  name: string;
  description: string;
  icon: string;
  steps: WorkflowStep[];
  /** True when any step needs shell/file tools. */
  toolsRequired?: boolean;
  category?: Exclude<BotCategory, "all">;
  isCustom?: boolean;
}

export interface BotPersona {
  id: string;
  name: string;
  slug: string;
  description: string;
  avatar: string;
  systemPrompt: string;
  defaultModel: string;
  temperature: number;
  autoApproveSafeTools: boolean;
  category?: BotCategory;
  suggestedPrompts?: BotPromptSuggestion[];
  tags?: string[];
  isCustom?: boolean;
}

export interface Thread {
  id: string;
  botId: string;
  /** Model this conversation runs on; restored when the thread is opened. */
  modelId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  isPinned?: boolean;
  /** True when this thread is a Team Room (multi-persona channel). */
  isRoom?: boolean;
  /** Room members (personas). `botId` remains the room's PRIMARY bot —
   *  the default addressee for messages without an @mention. */
  participantBotIds?: string[];
  /** Resume point for a workflow waiting on a human event in this thread. */
  pendingWorkflow?: { workflowId: string; nextStep: number; kind?: WorkflowGate["kind"] };
}

export interface VaultConfig {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  grokApiKey?: string;
  ollamaBaseUrl?: string;
  selectedModel?: string;
  theme?: "dark" | "light";
  autoApproveSafeTools?: boolean;
  /** True when credentials are encrypted in OS Keychain (SecretService/KWallet/macOS Keychain/Windows Credential Manager). */
  keychainStorageActive?: boolean;
}

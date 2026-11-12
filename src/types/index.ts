export type Role = "user" | "assistant" | "system" | "tool";

export type AIProvider = "anthropic" | "openai" | "ollama" | "grok";

export interface AIModel {
  id: string;
  name: string;
  provider: AIProvider;
  contextWindow: number;
  supportsThinking: boolean;
  supportsTools: boolean;
}

export type CommandSafetyTier = "Safe" | "Mutative" | "Dangerous";

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
  name: "execute_shell" | "read_file" | "write_file" | "list_directory";
  arguments: Record<string, any>;
  status: "pending_approval" | "running" | "completed" | "failed" | "rejected";
  safetyTier?: CommandSafetyTier;
  safetyReason?: string;
  /** Immutable native proposal token issued by the Rust backend. */
  proposalId?: string;
  result?: {
    output?: string;
    error?: string;
    /** Pre-write proposal: prepared BEFORE approval, not after the write. */
    diff?: { before: string; after: string; path: string; existed?: boolean };
    executionTimeMs?: number;
  };
}

export interface TranscriptEntry {
  id: string;
  threadId: string;
  role: Role;
  content: string;
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
}

export interface VaultConfig {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  grokApiKey?: string;
  ollamaBaseUrl?: string;
  selectedModel?: string;
  theme?: "dark" | "light";
  autoApproveSafeTools?: boolean;
}

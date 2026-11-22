import { AIModel } from "../../types";

export const isCliModel = (model: AIModel) => model.provider === "acp" || model.isByop === true;

export const AVAILABLE_MODELS: AIModel[] = [
  // Bring-Your-Own-Plan (BYOP) & Agent Client Protocol (ACP)
  {
    id: "byop-claude",
    name: "Claude Code (Subscription Plan)",
    provider: "acp",
    contextWindow: 200000,
    supportsThinking: true,
    supportsTools: true,
    isByop: true,
    agentEngine: "claude",
  },
  {
    id: "byop-codex",
    name: "Codex (ChatGPT Subscription)",
    provider: "acp",
    contextWindow: 128000,
    supportsThinking: true,
    supportsTools: true,
    isByop: true,
    agentEngine: "codex",
  },
  {
    id: "byop-opencode",
    name: "OpenCode (ACP Agent)",
    provider: "acp",
    contextWindow: 64000,
    supportsThinking: false,
    supportsTools: true,
    isByop: true,
    agentEngine: "opencode",
  },
  {
    id: "byop-zcode",
    name: "ZCode (ACP Agent)",
    provider: "acp",
    contextWindow: 128000,
    supportsThinking: true,
    supportsTools: true,
    isByop: true,
    agentEngine: "zcode",
  },
  {
    id: "byop-agy",
    name: "Antigravity agy (Google, Subscription)",
    provider: "acp",
    contextWindow: 128000,
    supportsThinking: true,
    supportsTools: true,
    isByop: true,
    agentEngine: "agy",
  },

  // Anthropic Claude (BYOK API Key)
  {
    id: "claude-3-7-sonnet-20250219",
    name: "Claude 3.7 Sonnet (Hybrid Thinking)",
    provider: "anthropic",
    contextWindow: 200000,
    supportsThinking: true,
    supportsTools: true,
  },
  {
    id: "claude-3-5-sonnet-20241022",
    name: "Claude 3.5 Sonnet",
    provider: "anthropic",
    contextWindow: 200000,
    supportsThinking: false,
    supportsTools: true,
  },
  {
    id: "claude-3-5-haiku-20241022",
    name: "Claude 3.5 Haiku",
    provider: "anthropic",
    contextWindow: 200000,
    supportsThinking: false,
    supportsTools: true,
  },

  // OpenAI
  {
    id: "gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    contextWindow: 128000,
    supportsThinking: false,
    supportsTools: true,
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    provider: "openai",
    contextWindow: 128000,
    supportsThinking: false,
    supportsTools: true,
  },
  {
    id: "o3-mini",
    name: "o3-mini (Reasoning)",
    provider: "openai",
    contextWindow: 200000,
    supportsThinking: true,
    supportsTools: true,
  },

  // Local Ollama
  {
    id: "phi3:mini",
    name: "Phi-3 Mini (Local Ollama)",
    provider: "ollama",
    contextWindow: 128000,
    supportsThinking: false,
    supportsTools: false,
  },
  {
    id: "deepseek-r1:latest",
    name: "DeepSeek R1 (Local Ollama)",
    provider: "ollama",
    contextWindow: 64000,
    supportsThinking: true,
    supportsTools: true,
  },
  {
    id: "llama3.3:latest",
    name: "Llama 3.3 (Local Ollama)",
    provider: "ollama",
    contextWindow: 128000,
    supportsThinking: false,
    supportsTools: true,
  },
  {
    id: "qwen2.5-coder:latest",
    name: "Qwen 2.5 Coder (Local Ollama)",
    provider: "ollama",
    contextWindow: 32000,
    supportsThinking: false,
    supportsTools: true,
  },

  // xAI Grok
  {
    id: "grok-2",
    name: "Grok 2 (xAI)",
    provider: "grok",
    contextWindow: 131072,
    supportsThinking: false,
    supportsTools: true,
  },
  {
    id: "grok-beta",
    name: "Grok Beta (xAI)",
    provider: "grok",
    contextWindow: 131072,
    supportsThinking: false,
    supportsTools: true,
  },
];

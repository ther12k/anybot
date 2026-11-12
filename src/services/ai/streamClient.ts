import { AIModel, ToolCallItem, VaultConfig } from "../../types";
import { ANTHROPIC_TOOLS, OPENAI_TOOLS } from "./tools";

export interface StreamCallbacks {
  onThinkingDelta?: (delta: string) => void;
  onContentDelta?: (delta: string) => void;
  onToolCall?: (toolCall: ToolCallItem) => void;
  onFinished?: () => void;
  onError?: (err: Error) => void;
}

export interface ChatMessagePayload {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

/**
 * Inactivity watchdog for streaming reads. WebKitGTK (and some proxies) can
 * leave `reader.read()` pending forever after the server closes a chunked
 * body — the stream then stalls silently and Stop appears frozen. Racing
 * each read against this timeout turns that hang into a clean early end,
 * preserving everything streamed so far.
 */
const STREAM_INACTIVITY_TIMEOUT_MS = 45_000;

class StreamIdleTimeout extends Error {
  constructor() {
    super("stream idle timeout");
  }
}

async function readWithWatchdog<T>(
  read: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StreamIdleTimeout()), STREAM_INACTIVITY_TIMEOUT_MS);
  });
  // Disarm on abort so an intentional Stop rejects via the signal instead.
  const onAbort = () => clearTimeout(timer);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([read(), idle]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function streamChatCompletion(
  model: AIModel,
  vault: VaultConfig,
  messages: ChatMessagePayload[],
  systemPrompt: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  try {
    if (model.provider === "anthropic") {
      await streamAnthropic(model, vault, messages, systemPrompt, callbacks, signal);
    } else if (model.provider === "ollama") {
      await streamOllama(model, vault, messages, systemPrompt, callbacks, signal);
    } else {
      // OpenAI or Grok (xAI uses OpenAI-compatible API format)
      await streamOpenAI(model, vault, messages, systemPrompt, callbacks, signal);
    }
  } catch (err: any) {
    if (signal?.aborted) return;
    // Idle-timeout stalls (WebKitGTK can leave reader.read() pending after
    // the server closes) end the stream gracefully: keep the partial answer,
    // signal finished, and don't surface a scary error for usable content.
    if (err instanceof StreamIdleTimeout) {
      callbacks.onFinished?.();
      return;
    }
    callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
    // Re-throw so the agent loop renders the failure; a swallowed error
    // otherwise reads as a successful empty turn.
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// 1. Anthropic Claude Streaming Implementation
async function streamAnthropic(
  model: AIModel,
  vault: VaultConfig,
  messages: ChatMessagePayload[],
  systemPrompt: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal
) {
  const apiKey = vault.anthropicApiKey?.trim();
  if (!apiKey) {
    throw new Error(
      "Anthropic API key is missing. Open Settings (gear icon in the sidebar), paste a key under “Anthropic API key”, or switch to a local Ollama model above the message box."
    );
  }

  // Filter messages for Anthropic (system prompt is top-level).
  // Assistant tool calls must become tool_use blocks, or a following
  // tool_result has no matching tool_use and the API rejects the turn.
  const anthropicMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.role === "tool") {
        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: m.tool_call_id,
              content: m.content,
            },
          ],
        };
      }
      if (m.tool_calls && m.tool_calls.length > 0) {
        const content: any[] = [];
        if (m.content) {
          content.push({ type: "text", text: m.content });
        }
        for (const tc of m.tool_calls) {
          let input: any = {};
          try {
            input = JSON.parse(tc.function?.arguments || "{}");
          } catch {
            input = {};
          }
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function?.name,
            input,
          });
        }
        return { role: m.role, content };
      }
      return {
        role: m.role,
        content: m.content,
      };
    });

  const payload: any = {
    model: model.id,
    max_tokens: 4096,
    system: systemPrompt,
    messages: anthropicMessages,
    tools: ANTHROPIC_TOOLS,
    stream: true,
  };

  if (model.supportsThinking) {
    payload.thinking = {
      type: "enabled",
      budget_tokens: 2048,
    };
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errorBody}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response stream available.");

  const decoder = new TextDecoder();
  let buffer = "";
  let currentToolCall: any = null;

  while (true) {
    const { done, value } = await readWithWatchdog(() => reader.read(), signal);
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const dataStr = trimmed.slice(6);
      if (dataStr === "[DONE]") continue;

      try {
        const parsed = JSON.parse(dataStr);
        if (parsed.type === "content_block_start") {
          if (parsed.content_block?.type === "thinking") {
            // Started thinking
          } else if (parsed.content_block?.type === "tool_use") {
            currentToolCall = {
              id: parsed.content_block.id,
              name: parsed.content_block.name,
              argumentsStr: "",
            };
          }
        } else if (parsed.type === "content_block_delta") {
          const delta = parsed.delta;
          if (delta.type === "thinking_delta") {
            callbacks.onThinkingDelta?.(delta.thinking);
          } else if (delta.type === "text_delta") {
            callbacks.onContentDelta?.(delta.text);
          } else if (delta.type === "input_json_delta") {
            if (currentToolCall) {
              currentToolCall.argumentsStr += delta.partial_json;
            }
          }
        } else if (parsed.type === "content_block_stop") {
          if (currentToolCall) {
            let args = {};
            try {
              args = JSON.parse(currentToolCall.argumentsStr || "{}");
            } catch (e) {
              args = {};
            }
            callbacks.onToolCall?.({
              id: currentToolCall.id,
              name: currentToolCall.name,
              arguments: args,
              status: "pending_approval",
            });
            currentToolCall = null;
          }
        }
      } catch (err) {
        // Continue parsing
      }
    }
  }

  callbacks.onFinished?.();
}

// 2. OpenAI & Grok Streaming Implementation
async function streamOpenAI(
  model: AIModel,
  vault: VaultConfig,
  messages: ChatMessagePayload[],
  systemPrompt: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal
) {
  const isGrok = model.provider === "grok";
  // Each provider only ever gets its own credential — never fall back to
  // another provider's key, which would leak it across a service boundary.
  const apiKey = isGrok
    ? vault.grokApiKey?.trim()
    : vault.openaiApiKey?.trim();
  const endpoint = isGrok
    ? "https://api.x.ai/v1/chat/completions"
    : "https://api.openai.com/v1/chat/completions";

  if (!apiKey) {
    throw new Error(
      `${isGrok ? "xAI (Grok)" : "OpenAI"} API key is missing. Open Settings (gear icon in the sidebar) and add a key for this provider, or switch to a local Ollama model above the message box.`
    );
  }

  const formattedMessages: any[] = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool",
          tool_call_id: m.tool_call_id,
          content: m.content,
        };
      }
      return {
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls,
      };
    }),
  ];

  const payload: any = {
    model: model.id,
    messages: formattedMessages,
    tools: OPENAI_TOOLS,
    stream: true,
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`AI API error (${response.status}): ${errorBody}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response stream available.");

  const decoder = new TextDecoder();
  let buffer = "";
  const toolCallAccumulators: Record<number, { id: string; name: string; args: string }> = {};

  while (true) {
    const { done, value } = await readWithWatchdog(() => reader.read(), signal);
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const dataStr = trimmed.slice(6);
      if (dataStr === "[DONE]") continue;

      try {
        const parsed = JSON.parse(dataStr);
        const choice = parsed.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (!delta) continue;

        // Reasoning / Thinking delta (e.g. o3-mini or DeepSeek reasoning_content)
        if (delta.reasoning_content) {
          callbacks.onThinkingDelta?.(delta.reasoning_content);
        }

        // Standard text content
        if (delta.content) {
          callbacks.onContentDelta?.(delta.content);
        }

        // Tool calls delta
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index ?? 0;
            if (!toolCallAccumulators[index]) {
              toolCallAccumulators[index] = {
                id: tc.id || `call_${Date.now()}_${index}`,
                name: tc.function?.name || "",
                args: "",
              };
            }
            if (tc.function?.name) {
              toolCallAccumulators[index].name = tc.function.name;
            }
            if (tc.function?.arguments) {
              toolCallAccumulators[index].args += tc.function.arguments;
            }
          }
        }
      } catch (e) {
        // Continue
      }
    }
  }

  // Flush accumulated tool calls
  for (const tc of Object.values(toolCallAccumulators)) {
    let args = {};
    try {
      args = JSON.parse(tc.args || "{}");
    } catch (e) {
      args = {};
    }
    callbacks.onToolCall?.({
      id: tc.id,
      name: tc.name as any,
      arguments: args,
      status: "pending_approval",
    });
  }

  callbacks.onFinished?.();
}

// 3. Local Ollama Streaming Implementation
async function streamOllama(
  model: AIModel,
  vault: VaultConfig,
  messages: ChatMessagePayload[],
  systemPrompt: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal
) {
  const baseUrl = (vault.ollamaBaseUrl?.trim() || "http://localhost:11434").replace(/\/$/, "");

  const formattedMessages: any[] = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool",
          content: m.content,
        };
      }
      return {
        role: m.role,
        content: m.content,
      };
    }),
  ];

  // Ollama 400s ("does not support tools") when a tool-less model receives
  // a tools field — only send it for models that declare support.
  const payload: Record<string, unknown> = {
    model: model.id,
    messages: formattedMessages,
    stream: true,
  };
  if (model.supportsTools) {
    payload.tools = OPENAI_TOOLS;
  }

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Ollama error (${response.status}): ${errorBody}. Make sure Ollama is running at ${baseUrl}`
    );
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response stream available.");

  const decoder = new TextDecoder();
  let buffer = "";
  let insideThinkTag = false;

  while (true) {
    const { done, value } = await readWithWatchdog(() => reader.read(), signal);
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);
        const msg = parsed.message;
        if (!msg) continue;

        // Native thinking field or <think> tag parsing (DeepSeek-R1)
        if (msg.thinking) {
          callbacks.onThinkingDelta?.(msg.thinking);
        }

        if (msg.content) {
          let text = msg.content;
          if (text.includes("<think>")) {
            insideThinkTag = true;
            text = text.replace("<think>", "");
          }
          if (text.includes("</think>")) {
            insideThinkTag = false;
            const parts = text.split("</think>");
            callbacks.onThinkingDelta?.(parts[0]);
            callbacks.onContentDelta?.(parts[1]);
            continue;
          }

          if (insideThinkTag) {
            callbacks.onThinkingDelta?.(text);
          } else {
            callbacks.onContentDelta?.(text);
          }
        }

        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            callbacks.onToolCall?.({
              id: `ollama_call_${Date.now()}_${Math.random().toString(36).substring(7)}`,
              name: tc.function?.name,
              arguments: tc.function?.arguments || {},
              status: "pending_approval",
            });
          }
        }
      } catch (e) {
        // Continue
      }
    }
  }

  callbacks.onFinished?.();
}

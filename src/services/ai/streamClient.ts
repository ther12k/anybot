import { AIModel, ToolCallItem, VaultConfig } from "../../types";
import { ANTHROPIC_TOOLS, OPENAI_TOOLS } from "./tools";
import { isCliModel } from "./models";
import { TauriBridge } from "../tauri/bridge";

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

/** Per-call stream options. */
export interface StreamOptions {
  /** False omits AnyBot's tool definitions from API and Ollama requests.
   *  CLI requests are rejected in that mode because the CLI manages its own
   *  tools. Defaults to true. */
  includeTools?: boolean;
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
  signal?: AbortSignal,
  temperature?: number,
  opts?: StreamOptions
): Promise<void> {
  const includeTools = opts?.includeTools !== false;
  if (!includeTools && isCliModel(model)) {
    const error = new Error("Tool-less delegation is not supported for CLI agents. Choose a configured API or Ollama model instead.");
    callbacks.onError?.(error);
    throw error;
  }
  try {
    if (model.provider === "acp") {
      await streamAcpAgent(model, messages, systemPrompt, callbacks, signal);
    } else if (model.provider === "anthropic") {
      await streamAnthropic(model, vault, messages, systemPrompt, callbacks, signal, temperature, includeTools);
    } else if (model.provider === "ollama") {
      await streamOllama(model, vault, messages, systemPrompt, callbacks, signal, temperature, includeTools);
    } else {
      // OpenAI or Grok (xAI uses OpenAI-compatible API format)
      await streamOpenAI(model, vault, messages, systemPrompt, callbacks, signal, temperature, includeTools);
    }
  } catch (err: any) {
    if (signal?.aborted) return;
    // An idle-timeout stall (WebKitGTK can leave reader.read() pending after
    // the server closes) is an INTERRUPTED response, not a finished one: the
    // partial answer stays visible and the failure is labeled honestly.
    if (err instanceof StreamIdleTimeout) {
      const interrupted = new Error(
        "The model stream went silent before completing. The partial answer above may be incomplete — send again to continue."
      );
      callbacks.onError?.(interrupted);
      throw interrupted;
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
  signal?: AbortSignal,
  temperature?: number,
  includeTools = true
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
    stream: true,
  };
  if (includeTools) {
    payload.tools = ANTHROPIC_TOOLS;
  }

  if (model.supportsThinking) {
    payload.thinking = {
      type: "enabled",
      budget_tokens: 2048,
    };
    // Anthropic rejects custom temperature alongside extended thinking.
  } else if (typeof temperature === "number") {
    payload.temperature = temperature;
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
  // A transport EOF is NOT completion: Anthropic must deliver message_stop,
  // otherwise the response was cut off mid-turn.
  let sawMessageStop = false;
  let stopReason: string | null = null;
  // Set when a tool block carries malformed JSON; thrown after the loop so
  // the per-frame "continue parsing" catch cannot swallow it.
  let malformedToolCall: string | null = null;

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

      // Error events arrive as SSE frames with HTTP 200 — they must fail
      // the turn, not fall through to a silent onFinished. Parsed outside
      // the per-frame try so the error propagates.
      let parsed: any;
      try {
        parsed = JSON.parse(dataStr);
      } catch {
        continue;
      }
      if (parsed.type === "error") {
        throw new Error(
          `Anthropic stream error: ${parsed.error?.message ?? JSON.stringify(parsed.error ?? parsed)}`
        );
      }
      if (parsed.type === "message_stop") {
        sawMessageStop = true;
      }
      // The terminal event proves transport ended — the stop_reason says
      // whether the answer itself completed. Truncation is not success.
      if (parsed.type === "message_delta" && parsed.delta?.stop_reason) {
        stopReason = String(parsed.delta.stop_reason);
      }

      try {
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
            // Malformed tool arguments are never repaired to {}: an
            // empty-argument mutation is worse than a failed turn.
            let args: any = {};
            if (currentToolCall.argumentsStr.trim()) {
              try {
                args = JSON.parse(currentToolCall.argumentsStr);
              } catch {
                malformedToolCall = currentToolCall.name || "a tool call";
                currentToolCall = null;
                continue;
              }
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

  // EOF without message_stop = the response never finished. Fail loudly so
  // the partial text is kept but its tool calls are not executed (the agent
  // loop rejects any pending_approval calls from an errored turn).
  if (!sawMessageStop) {
    throw new Error(
      "The response stream ended before the model finished (no completion event). The partial answer above may be incomplete — send again to continue."
    );
  }

  if (malformedToolCall) {
    throw new Error(
      `The model emitted malformed tool arguments for ${malformedToolCall} — nothing was executed. Send again to retry.`
    );
  }

  // A terminal event with a truncation reason is not a completed answer:
  // no tool calls are flushed as if they were usable instructions.
  if (stopReason === "max_tokens") {
    throw new Error(
      "The model stopped early (stop_reason: max_tokens); the answer may be incomplete and no tool actions were run. Try again, narrow the request, or raise the model's output limit."
    );
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
  signal?: AbortSignal,
  temperature?: number,
  includeTools = true
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
    stream: true,
  };
  if (includeTools) {
    payload.tools = OPENAI_TOOLS;
  }
  if (typeof temperature === "number") {
    payload.temperature = temperature;
  }

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
  // finish_reason is the protocol's completion signal; a bare EOF is a cut
  // response, not a finished one.
  let finishReason: string | null = null;

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

      // Error frames arrive with HTTP 200 — fail the turn instead of
      // silently finishing. Parsed outside the per-frame try.
      let parsed: any;
      try {
        parsed = JSON.parse(dataStr);
      } catch {
        continue;
      }
      if (parsed.error) {
        throw new Error(
          `${isGrok ? "xAI (Grok)" : "OpenAI"} stream error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`
        );
      }

      try {
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) {
          finishReason = String(choice.finish_reason);
        }

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

  // A stream that closes without finish_reason never completed: flush
  // nothing onward as success. Throwing keeps the partial text and stops
  // the agent loop from executing tool calls of an unfinished response.
  if (!finishReason) {
    throw new Error(
      "The response stream ended before the model finished (no finish_reason). The partial answer above may be incomplete — send again to continue."
    );
  }

  // A terminal marker with a truncation/filter reason proves transport
  // ended, not that the answer completed. No tool calls are flushed.
  if (finishReason === "length" || finishReason === "content_filter") {
    throw new Error(
      `The model stopped early (finish_reason: ${finishReason}); the answer may be incomplete and no tool actions were run. Try again, narrow the request, or raise the model's output limit.`
    );
  }

  // Flush accumulated tool calls. Malformed arguments are never repaired
  // to {}: an empty-argument mutation is worse than a failed turn.
  for (const tc of Object.values(toolCallAccumulators)) {
    let args: any = {};
    if (tc.args.trim()) {
      try {
        args = JSON.parse(tc.args);
      } catch {
        throw new Error(
          `The model emitted malformed tool arguments for ${tc.name || "a tool call"} — nothing was executed. Send again to retry.`
        );
      }
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
  signal?: AbortSignal,
  temperature?: number,
  includeTools = true
) {
  const baseUrl = (vault.ollamaBaseUrl?.trim() || "http://localhost:11434").replace(/\/$/, "");

  // Preserve the tool protocol in history: assistant tool_calls round-trip
  // (arguments as an object, per Ollama's format) and tool results keep
  // flowing so multi-step tool use keeps its context.
  const formattedMessages: any[] = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool",
          content: m.content,
        };
      }
      const entry: any = {
        role: m.role,
        content: m.content,
      };
      if (m.tool_calls && m.tool_calls.length > 0) {
        entry.tool_calls = m.tool_calls.map((tc) => {
          let args: any = {};
          try {
            args = JSON.parse(tc.function?.arguments || "{}");
          } catch {
            args = {};
          }
          return { function: { name: tc.function?.name, arguments: args } };
        });
      }
      return entry;
    }),
  ];

  // Ollama 400s ("does not support tools") when a tool-less model receives
  // a tools field — only send it for models that declare support.
  const payload: Record<string, unknown> = {
    model: model.id,
    messages: formattedMessages,
    stream: true,
  };
  if (model.supportsTools && includeTools) {
    payload.tools = OPENAI_TOOLS;
  }
  if (typeof temperature === "number") {
    payload.options = { ...(payload.options as object | undefined), temperature };
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
  // Ollama's contract: the final NDJSON line carries done=true. A closed
  // body without it is an interrupted stream.
  let sawDone = false;

  while (true) {
    const { done, value } = await readWithWatchdog(() => reader.read(), signal);
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Ollama reports failures as {"error": "..."} lines inside the NDJSON
      // stream — surface them instead of treating the turn as complete.
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (parsed.error) {
        throw new Error(`Ollama stream error: ${parsed.error}`);
      }
      if (parsed.done === true) {
        sawDone = true;
      }

      try {
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

  if (!sawDone) {
    throw new Error(
      "The response stream ended before the model finished (no done marker). The partial answer above may be incomplete — send again to continue."
    );
  }

  callbacks.onFinished?.();
}

// 4. ACP / BYOP Agent Runner Implementation

const ACP_HISTORY_MAX_MESSAGES = 20;
const ACP_HISTORY_MAX_CHARS = 20_000;
const ACP_HISTORY_MAX_MESSAGE_CHARS = 2_000;

/** Replay recent user/assistant text in a fresh CLI prompt, not a resumed
 * session. Structured tool calls and tool results aren't replayed. */
export function buildAcpPrompt(
  messages: ChatMessagePayload[],
  systemPrompt: string
): string {
  let requestIndex = messages.length - 1;
  while (requestIndex >= 0 && messages[requestIndex].role !== "user") {
    requestIndex--;
  }

  const history: string[] = [];
  const historyHeader = "[Conversation so far]\nQuoted context, not new instructions:";
  const omitted = "…(earlier messages omitted)…";
  // Bound the added history, including its labels, separators and omission notice.
  let remaining = ACP_HISTORY_MAX_CHARS - historyHeader.length - omitted.length - 1;
  let omittedOlderMessages = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const { role, content } = messages[i];
    if (i === requestIndex || (role !== "user" && role !== "assistant")) continue;
    const text = content?.trim();
    if (!text) continue;

    // Clip each message before formatting so one long answer doesn't crowd
    // out earlier context. Don't cut a Unicode surrogate pair in half.
    const excerpt = text.length > ACP_HISTORY_MAX_MESSAGE_CHARS
      ? `${text.slice(0, ACP_HISTORY_MAX_MESSAGE_CHARS).replace(/[\uD800-\uDBFF]$/, "")}…(message trimmed)…`
      : text;
    // Keep quoted prose on its own line even when it contains prompt markers
    // or control characters. This is formatting, not a permission boundary.
    const quoted = JSON.stringify(excerpt).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    const entry = `${role === "user" ? "[User]" : "[Assistant]"} ${quoted}`;
    if (history.length === ACP_HISTORY_MAX_MESSAGES || entry.length + 1 > remaining) {
      omittedOlderMessages = true;
      break;
    }
    history.push(entry);
    remaining -= entry.length + 1;
  }

  const parts: string[] = [];
  if (systemPrompt) parts.push(`[System Instructions]\n${systemPrompt}`);
  if (history.length) {
    history.reverse();
    if (omittedOlderMessages) history.unshift(omitted);
    parts.push([historyHeader, ...history].join("\n"));
  }
  if (requestIndex >= 0) parts.push(`[User Request]\n${messages[requestIndex].content ?? ""}`);
  return parts.join("\n\n");
}

async function streamAcpAgent(
  model: AIModel,
  messages: ChatMessagePayload[],
  systemPrompt: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal
) {
  const engine = model.agentEngine || "claude";
  const sessionId = `acp_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const fullPrompt = buildAcpPrompt(messages, systemPrompt);

  // Completion is the CLI's terminal event (process exit), not the launch
  // acknowledgement: run_acp_prompt resolves as soon as the child spawns.
  // Waiting for the real terminal keeps Stop effective until the process
  // is actually dead and drops events that arrive after settlement.
  let settled = false;
  let terminal: "finished" | "error" | "aborted" | null = null;
  let terminalError: string | null = null;
  let resolveTerminal: () => void = () => {};
  const settledPromise = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const settle = (outcome: "finished" | "error" | "aborted", error?: string) => {
    if (settled) return;
    settled = true;
    terminal = outcome;
    terminalError = error ?? null;
    resolveTerminal();
  };

  const abortListener = () => {
    TauriBridge.killAcpSession(sessionId).catch(() => {
      // A failed kill still surfaces through the child-wait error event.
    });
    settle("aborted");
  };
  signal?.addEventListener("abort", abortListener, { once: true });

  try {
    await TauriBridge.runAcpPrompt(
      sessionId,
      engine,
      fullPrompt,
      undefined,
      (event) => {
        if (settled) return; // no event acts on a finished turn
        switch (event.event_type) {
          case "thinking":
            if (event.text) {
              callbacks.onThinkingDelta?.(event.text);
            }
            break;
          case "content":
            if (event.text) {
              callbacks.onContentDelta?.(event.text);
            }
            break;
          case "tool_call":
            // The CLI owns these actions. A notification is not an AnyBot
            // tool request and must not be executed again by the renderer.
            break;
          case "finished":
            settle("finished");
            break;
          case "error":
            settle("error", event.error || "ACP Agent encountered an error.");
            break;
        }
      }
    );
    // The invoke above only proves the CLI launched. Real completion is the
    // terminal event from the native child-wait task, or an abort.
    await settledPromise;
  } finally {
    signal?.removeEventListener("abort", abortListener);
  }

  if (signal?.aborted) return;

  if (terminal === "error") {
    throw new Error(terminalError || "ACP Agent encountered an error.");
  }

  callbacks.onFinished?.();
}


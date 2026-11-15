export const TOOL_DEFINITIONS = [
  {
    name: "execute_shell",
    description: "Execute a command in the local terminal shell (e.g., bash). Use this to inspect the environment, run build commands, git operations, or run tests.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
        cwd: {
          type: "string",
          description: "Optional working directory in which to execute the command.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read the text content of a file from the local filesystem.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to the file.",
        },
        max_lines: {
          type: "number",
          description: "Optional maximum number of lines to read.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file on the local filesystem. Overwrites existing content or creates new file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to create or overwrite.",
        },
        content: {
          type: "string",
          description: "Full text content to write into the file.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description: "List files and subdirectories in a local directory path.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the directory to list.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "delegate_task",
    description:
      "Delegate a self-contained task to another bot persona on the roster (e.g. the security reviewer, the researcher). The other bot answers in ONE reply with no tool access of its own; its answer comes back as this tool's result. Use it for second opinions or persona-specific expertise. The task text must be complete and standalone — the other bot sees nothing else of this conversation.",
    parameters: {
      type: "object",
      properties: {
        bot: {
          type: "string",
          description:
            "Name or slug of the target bot, e.g. 'PR Reviewer & SecOps' or 'pr-reviewer'.",
        },
        task: {
          type: "string",
          description: "The complete, self-contained task for that bot.",
        },
      },
      required: ["bot", "task"],
    },
  },
];

// Format for Anthropic Tools API
export const ANTHROPIC_TOOLS = TOOL_DEFINITIONS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.parameters,
}));

// Format for OpenAI / Grok / Ollama function calling
export const OPENAI_TOOLS = TOOL_DEFINITIONS.map((tool) => ({
  type: "function" as const,
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}));

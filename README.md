# AnyBot ⚡ - Autonomous Desktop AI Agent

**AnyBot** is a desktop AI agent built with **Tauri v2**, **Rust**, and **React 18**. Desktop workspaces pair explicitly granted file tools with Anthropic Claude, OpenAI, Ollama, and xAI Grok models.

---

## 🔍 Grok Bot Reverse-Engineering Teardown

During analysis of `grok-bot_0.79.4_amd64.deb` (`@anysphere/grok-bot` / SpaceXAI / Anysphere):
* **Desktop Shell**: Grok Bot was built on Electron + React 19 + TipTap + ConnectRPC (`proto.cjs`).
* **Tool & Execution Daemon**: Grok Bot ran `local-exec-daemon` with an AES-256 encrypted supervisor heartbeat, parsing bash commands using `tree-sitter-bash` ASTs to detect redirects and substitutions.
* **Agent Loop**: Models (`grok-4.5`, `grok-4.6`, and `claude-4.5-sonnet`) were coordinated via a gateway, streaming thinking blocks (`Thinking` pills) and tool execution cards (`Running commands`, `Reading files`).

### How AnyBot Improves on Grok Bot
* **Native Rust Backend**: Instead of a Node.js daemon inside an Electron runtime, AnyBot runs a native **Rust Tauri backend**. (We don't publish memory/startup numbers without a reproducible benchmark — measure it on your hardware.)
* **Unified Multi-Provider Support**: **Anthropic Claude** (with extended thinking tokens), **OpenAI** (`gpt-4o`, `o3-mini`), **Local Ollama**, and **xAI Grok**. Each provider only ever receives its own credential.
* **Human-in-the-Loop Safety**: Policy- and argument-aware command classification (`Safe` vs `Mutative` vs `Dangerous`) — read-only forms auto-run only when their arguments are proven read-only; everything else asks.
* **Reviewed Changes**: File writes prepare the exact diff BEFORE approval; the reviewer sees what will change, and approval is bound to that exact proposal (a file changed after review forces re-review instead of overwriting).
* **Meet Tavi 🌱**: a small companion character whose expression follows the real run state — never a substitute for the status text.

---

## 🏗️ Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                     AnyBot Desktop App                        │
│                                                               │
│  ┌────────────────────── React 18 Frontend ────────────────┐  │
│  │                                                         │  │
│  │  ┌──────────────┐  ┌───────────────────┐  ┌───────────┐ │  │
│  │  │ Left Sidebar │  │   Chat Transcript │  │ Right Info│ │  │
│  │  │ - Bot Roster │  │ - Thinking Drawer │  │ Drawer    │ │  │
│  │  │ - Thread List│  │ - Tool Cards (Appr)│ │ - Bot Meta │ │  │
│  │  │ - Settings   │  │ - Change Review   │ │ - Skills  │ │  │
│  │  │ - New Chat   │  │ - Model Switcher  │  │ - Safety  │ │  │
│  │  └──────────────┘  └───────────────────┘  └───────────┘ │  │
│  │                                                         │  │
│  │  ┌────────────────────────────────────────────────────┐ │  │
│  │  │  Agent Loop (per-run context) & Multi-Provider     │ │  │
│  │  │  Client (Claude + OpenAI + Ollama + xAI Grok)      │ │  │
│  │  └────────────────────────────────────────────────────┘ │  │
│  └───────────────────────────┬─────────────────────────────┘  │
│                              │ Tauri IPC (invoke/listen)      │
│  ┌───────────────────────────▼─────────────────────────────┐  │
│  │                   Tauri / Rust Backend                  │  │
│  │                                                         │  │
│  │  - Native Shell Executor (process-group tracked)        │  │
│  │  - Atomic File I/O (audit every read/write outcome)     │  │
│  │  - Policy re-evaluation at execution (fail-closed)      │  │
│  │  - OS keychain for credentials                          │  │
│  │  - System Diagnostics (OS, CWD, user environment)       │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

---

## 🚀 Getting Started

### Prerequisites
* **Node.js**: v18+ (v20+ recommended)
* **Rust**: `rustc` and `cargo` installed via [rustup.rs](https://rustup.rs)
* **Linux Libraries** (Ubuntu/Debian): `libgtk-3-dev`, `libwebkit2gtk-4.1-dev` (or `libwebkit2gtk-4.0-dev`)

### Installation
```bash
# Clone the repository
git clone https://github.com/ther12k/anybot.git
cd anybot

# Install npm dependencies
npm install
```

### Running in Development
```bash
# Option 1: Run the full native desktop app with Tauri
npm run tauri dev

# Option 2: Run in browser for rapid UI design and testing
npm run dev
```

### Building for Production
```bash
# Compile optimized native binary and installer
npx tauri build
```

---

## 🤖 Built-in Agent Personas

Ten pre-configured agents ship with the library (categories: Code, Research, Productivity, Writing, Fun). Highlights:

1. **Grok (⚡)**: general-purpose witty desktop assistant; defaults to the local `phi3:mini` model so it works with zero API keys (chat-only until you switch to a tool-capable model).
2. **Code Architect (🛠️) / PR Reviewer & SecOps (🛡️)**: architecture, code review, and security auditing with native tool access.
3. **Deep Researcher (🔬)**: analytical research and synthesis (chat-oriented starters).
4. **Local Offline Agent (🦙)**: a persona designed to pair with local Ollama models. Honesty note: where your prompts actually go is decided by the **model selector**, not the agent name — pick a local model to keep processing local.

Starter prompts are capability-aware: on a chat-only model (e.g. `phi3:mini`), file/command starters are shown disabled with an explanation instead of promising actions the model can't take.

---

## Import a session

In **Chats**, select **Import session** and choose a source:

- **ZCode**: In the desktop app, choose from up to 100 recent, active top-level sessions in the local ZCode CLI store. Select **Preview session**, then **Import session**.
- **Claude Code**: Choose a session `.jsonl` file. Claude Code typically stores these under `~/.claude/projects/<project>/`.

Imports go into the current workspace as read-only transcripts containing visible user and assistant text. Tool calls and results, approvals, attachments, and reasoning are not imported. Importing does not contact a model or modify the source session. To continue, select **Continue in a new chat** and choose an installed agent. The original stays unchanged; sending a message in the new chat gives the selected model the copied history as context. Imports exceeding 400 messages or 512 KiB of retained data are rejected rather than truncated.

## Private desktop workspaces

Open **Manage workspaces** from the sidebar workspace button. Create or switch workspaces, add folders with **Read-only** or **Read/write** access, then install an agent and explicitly select its tools. A new installation has no grants by default; a file write also requires review of that exact change.

Existing chats and rooms move into the default workspace without automatically granting folders or tools. Uninstalling an agent keeps its history but does not reassign the conversation to a new installation. Rooms share conversation text, not raw tool outputs. Delegation stays within the current workspace, uses the conversation’s model, and gives the recipient no tools.

Chats and workspace configuration are stored on this device. Selecting a cloud model sends conversation context and in-run tool results to that provider. Provider credentials are still configured globally; per-workspace connection bindings and durable run records are not implemented. Shell execution and external CLI/ACP models are not available to workspace bots. The native file checks are not an OS sandbox and do not prevent races with another process that modifies a granted directory.

## 🛡️ Governance & Permissions

The legacy shell and ACP backend endpoints below are not exposed to workspace bots.

* **Deny-First Policy Engine**: Configurable via `~/.config/anybot/policy.json`. Deny patterns (`rm -rf /`, `mkfs`, `dd if=`) and `deny_commands` are evaluated first and cannot be overridden by user grants. Unknown commands default to requiring approval.
* **Argument-aware classification**: Allowlisted commands are validated by form, not just name — `git branch -D x`, `git branch <new>`, `git remote remove`, `git tag v1`, and `env <cmd>` are all approval-required; `env touch x` no longer inherits `env`'s safe reputation. `cargo check`/`npx` are deliberately NOT auto-approved (build scripts / package installs execute code).
* **Fail-closed shell execution**: Compound, redirected, OR BACKGROUND syntax (`;`, `&&`, `||`, `&`, `|`, `>`, `$(`, backticks) never inherits a safe prefix — `pwd && touch x`, `cat a > b`, and `ls & touch x` all require approval.
* **Standing grants ("Always allow")**: Exact command identity, **case-sensitive**, and (for new grants) **scoped to the working directory** they were approved in. Legacy string grants still match everywhere. Grants can never override deny patterns, deny commands, or compound syntax.
* **Native enforcement point**: The shell endpoint re-evaluates policy at execution time. Every file write and every command that requires approval needs a single-use native proposal token. The renderer's `approved` string cannot authorize an action.
* **Protected configuration**: The file tools block AnyBot's own governance files (`config.json`, `policy.json`, `standing-grants.json`, `audit.jsonl`). The shell route screens literal references to these paths; it is not a filesystem sandbox.
* **Backend-Owned Proposal Registry (Prepare–Review–Apply)**: Rust binds approval to the reviewed path and content. Writes use an exclusive temporary file in the destination directory. The writer rechecks the destination just before replacement and publishes reviewed new files without overwriting an entry that already exists. This is not an atomic compare-and-replace for existing files: another editor can still save after the final check.
* **Local audit logging (`~/.config/anybot/audit.jsonl`)**: AnyBot attempts to record native shell and file outcomes and reported rejections and delegations. If recording fails, the desktop app warns that activity may be missing. Recording is best-effort: it does not undo a command or edit that already ran. Tools run by external CLI agents are not part of this log.
* **Audit log → Verify chain**: The native verifier checks SHA-256 links for records still present and reports missing, empty, unreadable, legacy-only, consistent, and broken logs separately. A consistent result shows up to 25 checked records with only an action, outcome, record number, and formatted time. Commands, paths, and other raw details are not exposed by the view. Chain consistency does not prove every action was recorded, that appends were durable, or that no complete records were removed from the end.
* **Bring-Your-Own-Plan (BYOP) & Agent Client Protocol (ACP)**: AnyBot supports running models via your existing active subscriptions (Claude Code CLI `claude`, OpenAI Codex CLI `codex`, OpenCode `opencode`, `zcode`, and Google Antigravity `agy`) with **zero token fees**. The Rust backend automatically scans `$PATH` and local directories for installed agent CLIs, normalizes stream-json/JSON-RPC protocols into unified streaming events, and manages process groups (`SIGKILL` on Stop). Settings displays real-time detection badges for installed agent CLIs, and Composer categorizes models by BYOP Subscriptions vs BYOK API Keys vs Local Offline.
* **Bot-to-bot delegation (`delegate_task`)**: An agent with the delegation grant can ask another installation in the same workspace a self-contained question. The sub-run uses the conversation’s model and has **no tools**; the delegated bot cannot access files or delegate further. AnyBot attempts to record delegation outcomes in the audit log.
* **Team Rooms (Slack-style multi-agent channels)**: A Room is a thread with several personas plus you. `@mention` routes your message — every mentioned member answers **sequentially**, each seeing its teammates' prior replies (capped at 3 responders per message); a message without a mention goes to the room's **primary agent** (first member picked). Mention completion inserts the unique `@slug` so routing is unambiguous; hand-typed `@FirstName` only counts when it matches exactly one member. Each reply is attributed to its author (avatar + name in the transcript), responders run with a room-context system preamble, delegation audit provenance names the actual speaker, and Stop breaks the responder chain. Crucially, the trust boundary is unchanged: approvals, proposals, and the audit chain still answer to the single local human — the Slack pattern without Slack's autonomy problem.
* **Stop that actually stops**: Clicking **Stop** cancels streaming, resolves pending approvals as denied, and `SIGKILL`s the shell's process group (Unix). The composer shows **Stopping…** until the run has fully settled — you can't start a new task into a controller a dying run would clear (each run owns its own controller, approvals, and shell registry). Timeouts also kill the whole process group and reap it before reporting.
* **Platform limits**: process-group kill and timeout cleanup are Unix-only; on Windows the executor kills the process leader only and reports the limitation.
* **File review**: `write_file` shows the resolved path and exact diff (or contents for a new file) before approval. The destination directory must already exist. The writer does not replace symbolic links or read-only files, and a detected conflict requires a fresh review.

---

## 🔑 Configuration & API keys

Click the **gear icon** in the sidebar to configure:
* **Anthropic API key** — Claude 3.7 Sonnet (thinking) and 3.5 Sonnet / Haiku.
* **OpenAI API key** — GPT-4o and o3-mini.
* **xAI (Grok) API key** — Grok 2 / Grok Beta. Each provider only ever receives its own key.
* **Ollama endpoint** — local models at `http://localhost:11434` by default. Availability is checked when you send, not assumed from a saved URL.

🔒 **Credentials are secured by OS Keychain encryption**:
API keys are stored securely in your operating system's native secret service (GNOME Keyring / KWallet via D-Bus on Linux, Windows Credential Manager on Windows, or Apple Keychain on macOS). Non-sensitive settings in `~/.config/anybot/config.json` have their keys scrubbed and replaced with keychain placeholders, and the file is restricted to owner permissions (`0600`). Legacy installations with plain text keys are automatically migrated into the keychain on startup.

## 🧪 Verification status

* Rust tests on Linux cover scoped file authorization and limits, cross-workspace delegation, revocation, reviewed writes, and legacy tool behavior using disposable fixtures. JavaScript tests cover chat migration, scoped tool dispatch, approval cards, and provider responses through fixtures. The TypeScript and production build pass.
* The Linux desktop startup smoke created an empty default workspace with a disposable profile. A live desktop review → apply → audit interaction, packaged installers, and real provider calls remain unverified for workspace bots.

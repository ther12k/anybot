# AnyBot ⚡ - Autonomous Desktop AI Agent

**AnyBot** is a lightweight desktop AI agent inspired by the architecture and capabilities of **Grok Bot** (`sand`). Built with **Tauri v2**, **Rust**, and **React 18**, AnyBot pairs local system access (terminal execution, file read/write, directory inspection) with modern multi-model AI reasoning (Anthropic Claude, OpenAI, Local Ollama, and xAI Grok).

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
│  │  - Local API-key store (plaintext JSON, see note)       │  │
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

## 🛡️ Governance & Permissions (Inspired by OpenBot & Grok Bot)

* **Deny-First Policy Engine**: Configurable via `~/.config/anybot/policy.json`. Deny patterns (`rm -rf /`, `mkfs`, `dd if=`) and `deny_commands` are evaluated first and cannot be overridden by user grants. Unknown commands default to requiring approval.
* **Argument-aware classification**: Allowlisted commands are validated by form, not just name — `git branch -D x`, `git branch <new>`, `git remote remove`, `git tag v1`, and `env <cmd>` are all approval-required; `env touch x` no longer inherits `env`'s safe reputation. `cargo check`/`npx` are deliberately NOT auto-approved (build scripts / package installs execute code).
* **Fail-closed shell execution**: Compound, redirected, OR BACKGROUND syntax (`;`, `&&`, `||`, `&`, `|`, `>`, `$(`, backticks) never inherits a safe prefix — `pwd && touch x`, `cat a > b`, and `ls & touch x` all require approval.
* **Standing grants ("Always allow")**: Exact command identity, **case-sensitive**, and (for new grants) **scoped to the working directory** they were approved in. Legacy string grants still match everywhere. Grants can never override deny patterns, deny commands, or compound syntax.
* **Native enforcement point**: The shell endpoint re-evaluates policy at execution time. A mutative command arriving without a recorded `approved` decision is refused natively — the frontend's decision string is verified, not trusted. File writes without a recorded approval are refused the same way.
* **Protected configuration**: AnyBot's own files (`config.json`, `policy.json`, `standing-grants.json`, `audit.jsonl`) cannot be read or written by tools — stored API keys can never enter model context, and the permission boundary cannot be rewritten by the agent.
* **Backend-Owned Proposal Registry (Prepare–Review–Apply)**: Mutative file writes and commands prepare an immutable proposal registered natively in Rust (`src-tauri/src/proposal.rs`). Rust reads the disk file natively, computes SHA256 hashes of original and proposed content, and enforces that only an explicitly approved, single-use proposal token can execute the mutation. If the file on disk was modified by another process between proposal preparation and apply, Rust's atomic conflict check cancels the token and refuses to overwrite.
* **Audit logging (`~/.config/anybot/audit.jsonl`)**: Every tool action and outcome is recorded — shell (completed/failed/killed/timeout/blocked/spawn_error), file reads, directory listings, and writes (including failures, which are audited before the error returns). Rows carry decision provenance (`auto_safe`, `standing_grant`, `approved`, `rejected`, `blocked`), proposal IDs, durations, and call IDs.
* **Stop that actually stops**: Clicking **Stop** cancels streaming, resolves pending approvals as denied, and `SIGKILL`s the shell's process group (Unix). The composer shows **Stopping…** until the run has fully settled — you can't start a new task into a controller a dying run would clear (each run owns its own controller, approvals, and shell registry). Timeouts also kill the whole process group and reap it before reporting.
* **Platform limits**: process-group kill and timeout cleanup are Unix-only; on Windows the executor kills the process leader only and reports the limitation.
* **Mutative actions**: `write_file` always prompts. The approval card shows the exact proposed diff (or full content for new files) BEFORE any approval control; approving writes only the reviewed proposal, and a file that changed between review and apply forces re-review instead of being overwritten.

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

* 30 Rust tests cover the classifier (mutative git forms, background `&`, zero-arg commands, scoped grants, fail-closed corruption), executor (kill stops `sleep 30` <5s, timeout terminates group), native proposal registry (immutable proposal creation, approval status transitions, single-use token consumption, content tampering rejection, and disk conflict detection), and secure vault storage (keyring API and 0600 file permission enforcement).
* TypeScript strict-clean; production build passes.
* Not yet verified: Windows descendant kill, packaged installers, live provider contracts with real credentials.

# AnyBot ⚡ - Autonomous Desktop AI Agent

**AnyBot** is an ultra-fast, lightweight desktop AI agent inspired by the architecture and capabilities of **Grok Bot** (`sand`). Built with **Tauri v2**, **Rust**, and **React 19**, AnyBot pairs local system access (terminal execution, file read/write, directory inspection) with modern multi-model AI reasoning (Anthropic Claude, OpenAI, Local Ollama, and xAI Grok).

---

## 🔍 Grok Bot Reverse-Engineering Teardown

During analysis of `grok-bot_0.79.4_amd64.deb` (`@anysphere/grok-bot` / SpaceXAI / Anysphere):
* **Desktop Shell**: Grok Bot was built on Electron + React 19 + TipTap + ConnectRPC (`proto.cjs`).
* **Tool & Execution Daemon**: Grok Bot ran `local-exec-daemon` with an AES-256 encrypted supervisor heartbeat, parsing bash commands using `tree-sitter-bash` ASTs to detect redirects and substitutions.
* **Agent Loop**: Models (`grok-4.5`, `grok-4.6`, and `claude-4.5-sonnet`) were coordinated via a gateway, streaming thinking blocks (`Thinking` pills) and tool execution cards (`Running commands`, `Reading files`).

### How AnyBot Improves on Grok Bot
* **Native Rust Performance**: Instead of a heavy Node.js daemon and Electron runtime consuming ~400MB+ RAM, AnyBot uses a native **Rust Tauri backend** consuming only ~25MB of RAM with sub-second startup.
* **Unified Multi-Provider Support**: Supports **Anthropic Claude** (with extended thinking tokens), **OpenAI** (`gpt-4o`, `o3-mini`), **Local Ollama** (`deepseek-r1`, `llama3.3` for 100% private offline AI), and **xAI Grok**.
* **Human-in-the-Loop Safety**: AST and prefix-based command categorization (`Safe` vs `Mutative` vs `Dangerous`), allowing instant auto-execution of read-only queries while requiring explicit approval cards for changes.
* **Live Diff Viewer**: Built-in visual side-by-side / inline diff viewer showing file modifications before and after writing.

---

## 🏗️ Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                     AnyBot Desktop App                        │
│                                                               │
│  ┌────────────────────── React 19 Frontend ────────────────┐  │
│  │                                                         │  │
│  │  ┌──────────────┐  ┌───────────────────┐  ┌───────────┐ │  │
│  │  │ Left Sidebar │  │   Chat Transcript │  │ Right Info│ │  │
│  │  │ - Bot Roster │  │ - Thinking Drawer │  │ Drawer    │ │  │
│  │  │ - Thread List│  │ - Tool Cards (Appr)│ │ - Bot Meta │ │  │
│  │  │ - Settings   │  │ - Code Diff Viewer│  │ - Skills  │ │  │
│  │  │ - New Chat   │  │ - Model Switcher  │  │ - Safety  │ │  │
│  │  └──────────────┘  └───────────────────┘  └───────────┘ │  │
│  │                                                         │  │
│  │  ┌────────────────────────────────────────────────────┐ │  │
│  │  │       Unified Agent Loop & Multi-Provider Client   │ │  │
│  │  │   (Claude Thinking + OpenAI + Ollama + xAI Grok)   │ │  │
│  │  └────────────────────────────────────────────────────┘ │  │
│  └───────────────────────────┬─────────────────────────────┘  │
│                              │ Tauri IPC (invoke/listen)      │
│  ┌───────────────────────────▼─────────────────────────────┐  │
│  │                   Tauri / Rust Backend                  │  │
│  │                                                         │  │
│  │  - Native Shell Executor (terminal commands + env)      │  │
│  │  - Atomic File I/O (safe writes, real diffs)            │  │
│  │  - Safety & Permission Evaluator (fail-closed)          │  │
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
# Clone or navigate to the project directory
cd /home/rizky/Workspace/Learning/anybot

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
# Compile optimized native binary and .deb installer
npx tauri build
```

---

## 🤖 Built-in Agent Personas

1. **Grok (⚡)**: General-purpose witty, ultra-capable desktop assistant with full command and file access.
2. **Code Architect (🛠️)**: Specialized in software architecture, code reviews, automated refactoring, and debugging.
3. **Deep Researcher (🔬)**: Deep analytical research, document synthesis, and report generation.
4. **Local Offline Agent (🦙)**: 100% offline agent running locally on your hardware via Ollama (supports `deepseek-r1` and `llama3.3`).

---

## 🛡️ Governance & Permissions (Inspired by OpenBot & Grok Bot)

* **Deny-First Policy Engine**: Configurable via `~/.config/anybot/policy.json`. Deny patterns (`rm -rf /`, `mkfs`, `dd if=`) and `deny_commands` are evaluated first and cannot be overridden by user grants. Unknown commands default to requiring approval.
* **Fail-Closed Shell Execution**: Compound or redirected syntax (`;`, `&&`, `||`, `|`, `>`, `$(`) never inherits a safe prefix — commands like `pwd && touch x` or `cat a > b` always require explicit approval.
* **Standing Grants ("Always allow")**: Users can choose **Always allow** on approval cards for repetitive commands (`cargo test`, `npm run build`), persisting exact-match grants in `~/.config/anybot/standing-grants.json`. Grants can never override dangerous patterns or compound syntax.
* **Audit Logging (`~/.config/anybot/audit.jsonl`)**: Every tool decision and outcome is recorded to an append-only JSONL log with ISO timestamps, decision provenance (`auto_safe`, `standing_grant`, `approved`, `rejected`), outcome status (`completed`, `failed`, `killed`, `rejected`, `timeout`), duration in ms, and call IDs.
* **Stop with Native Process Group Kill**: Clicking **Stop** (■) cancels streaming, resolves any pending approval as denied, and sends a native `SIGKILL` to the shell's process group so long-running commands (and their child processes) terminate immediately.
* **Mutative actions**: File modifications (`write_file`) always prompt with an approval card showing an interactive line-level diff before writing.

---

## 🔑 Configuration & API keys

Click the **gear icon** in the sidebar to configure:
* **Anthropic API key** — Claude 3.7 Sonnet (thinking) and 3.5 Sonnet / Haiku.
* **OpenAI API key** — GPT-4o and o3-mini.
* **xAI (Grok) API key** — Grok 2 / Grok Beta. Each provider only ever receives its own key.
* **Ollama endpoint** — local models at `http://localhost:11434` by default.

⚠️ **Keys are stored in plain text** at `~/.config/anybot/config.json` (mode depends on your umask). Protect your user account accordingly; OS keychain encryption is planned.

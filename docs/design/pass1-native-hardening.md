# Pass 1 — native boundary hardening

First implementation pass from the system design review of 21 November 2026 (`AnyBot-system-design-review.md`). Goal: make the enforcement layer match what the interface promises before adding any new execution integrations.

## What changed

### S01 — mutation endpoints no longer accept an approval string
`execute_shell_command` and `write_file_content` ignore a renderer-supplied `decision: "approved"`. Every approval-required mutation must carry a single-use native proposal token bound to the exact command/path and content. (`src-tauri/src/commands/shell.rs`, `src-tauri/src/commands/fs.rs`)

### S02 — deny rules are now absolute
`deny_patterns` and `deny_commands` produce a new `CommandSafetyTier::Denied`. The shell endpoint refuses denied commands before proposal consumption, so no token, approval, or standing grant can run them. The agent loop mirrors this: a denied tool call is rejected outright with no proposal to approve. (`src-tauri/src/security.rs`, `src-tauri/src/commands/shell.rs`, `src/services/agent/agentLoop.ts`)

### S03 — vault saves fail closed
A failed keychain store aborts the config save instead of falling back to a plaintext write. The migration tests cover preserving a legacy field when storing that field fails. These tests do not establish transactional recovery across the keychain and disk. (`src-tauri/src/commands/vault.rs`)

### S04 — protected governance files are screened on the shell route
`command_touches_protected_path` screens shell commands for literal references to the config directory's governance files (`config.json`, `policy.json`, `standing-grants.json`, `audit.jsonl`), with `~` expansion, for both auto-run and approved commands. `env` and `printenv` were removed from the default read-only allowlist — bare `env` dumps the whole inherited environment into model context. Documented limit: this is string screening, not a sandbox; obfuscated or compound forms still require approval scrutiny. (`src-tauri/src/commands/fs.rs`, `src-tauri/src/commands/shell.rs`, `src-tauri/src/security.rs`, `src-tauri/src/policy.rs`)

### S05 — ACP/BYOP completion is the terminal event, not the launch ack
The adapter no longer treats `run_acp_prompt`'s spawn acknowledgement as completion. It waits for the native child-wait task's `finished`/`error` event and drops events arriving after settlement. Stop requests native termination and settles the adapter locally; that is not confirmation that the child exited. (`src/services/ai/streamClient.ts`)

### S08 — truncation and malformed tool payloads are failures
OpenAI `finish_reason: length|content_filter` and Anthropic `stop_reason: max_tokens` throw instead of completing; tool calls from a truncated turn are never flushed. Malformed tool-argument JSON throws instead of being repaired to `{}` — an empty-argument mutation is worse than a failed turn. (`src/services/ai/streamClient.ts`)

### S12 (partial) — truthful ACP stop acknowledgement
`kill_acp_session` no longer removes session tracking before attempting the kill, and unsupported platforms return an error instead of claiming success. (`src-tauri/src/commands/agent_acp.rs`)

### Found during verification — proposal id collisions
Proposal ids were `prop_{w|s}_{ms}_{ms^const}` — deterministic per millisecond. Two proposals created in the same millisecond silently overwrote each other in the registry, so one review could authorize another's action. Ids now include a process-global counter. (`src-tauri/src/proposal.rs`)

## Verification

- `cargo test --offline --manifest-path src-tauri/Cargo.toml --no-default-features` — **50 passed** (42 existing + 8 new negative tests: approval-string rejection, deny-with-grant, denied-with-approval, shell reads of protected paths, fail-closed vault save, non-destructive migration, placeholder scrubbing, environment-inspection approval).
- `npm run build` — passed.
- Stream harness (bundled `streamChatCompletion` with SSE fixtures, no network): 8/8 — OpenAI length/malformed/valid, Anthropic max_tokens/malformed/valid, ACP completion timing (waits for the real terminal), ACP abort-before-terminal (kill issued, no completion, no throw).

## Open checks and follow-ups

S10 (workspace identity and durable runs), S14 (room authorship), and full Windows Stop support remain open. Remaining audit and concurrent-writer limitations are described below. Literal path screening does not isolate the shell, and subprocess exit and output ordering still need native integration checks.

Desktop manual checks still outstanding: live proposal review → apply → Files → audit verification, including a file changed on disk between review and approval. The native tests cover the filesystem and audit functions, not the desktop window or IPC wiring.

## Pass 1 continuation — workflow semantics and CLI context (S06/S07/S09)

### S06 — workflow advancement checks tool outcomes

A finished stream is not sufficient to advance. The runner stops on a failed or cancelled step. A native shell failure records its exit code and status in the transcript and reports them to the model. Only a successful retry of the exact action in a later model reply clears an execution failure; for shell calls this includes the resolved working directory and exact command. Both attempts remain visible. Rejected actions still block the chain, even if another attempt succeeds. This does not prove prompt-level task success if the model omits a required action. (`src/services/agent/agentLoop.ts`, `src/services/workflow.ts`)

### S07 — distinct reply and approval checkpoints

Morning dev briefing waits for an answer in its conversation. README refresh requires **Approve plan & continue**; **Decline & end workflow** stops without sending the next prompt. Approving the plan is not approval to write a file. A reply or decision is recorded in the transcript and the thread’s checkpoint is consumed before the next prompt is sent. Paused checkpoints survive reload; live execution does not reattach after restart. Saved built-in workflows receive the updated gates, while custom workflows and plain-string prompt steps remain supported. (`src/App.tsx`, `src/services/workflow.ts`, `src/data/defaultWorkflows.ts`)

### S09 — CLI context and tool-less delegation

ACP requests include up to 20 recent user/assistant messages in a 20,000-character history section. The current request is separate and appears once; structured tools and results are not replayed. This is fresh-prompt text context, not native session resumption. Tool-less delegation only uses configured API or Ollama models; the stream adapter rejects a CLI request before launch. CLI tool notifications do not invoke AnyBot tools, and workflows requiring AnyBot tool evidence or a plan approval cannot run through a CLI. (`src/services/ai/streamClient.ts`, `src/services/workflow.ts`, `src/App.tsx`)

### Verification (continuation)

- `npm test` — 34 fixture checks covering the agent loop, workflow runner, and CLI stream adapter. Provider and native-boundary calls are mocked.
- `npm run build` — passed.
- `cargo test --offline --manifest-path src-tauri/Cargo.toml --no-default-features` — 50 passed. This is not a live desktop acceptance test.
- Built-app browser fixture — restored and resumed the briefing after switching threads and reloading; kept the remaining prompt unsent after a resumed step failed; declined a README plan without advancing; approved a restored plan and reached a separate file review; stopped a running chain before its next step. No real provider or native tools ran.

## S13 — revalidate native writes after staging

- The proposal identifies the resolved destination and the original file version. Consuming a token authorizes one attempt using the exact submitted path and payload. A conflict or staging error cannot reuse that approval. Parent directories must already exist; no folders are silently created during apply.
- The writer stages and syncs the replacement in an exclusively created temporary file beside the destination. A process-local lock serializes final validation and publication between AnyBot writes. Existing files are rechecked against the reviewed version immediately before replacement; reviewed-new files use a no-clobber publish operation. Stages are cleaned up on ordinary failed attempts.
- Existing targets must be writable regular files. Unix writes preserve basic permission bits and refuse an owner/group mismatch, hard links, and special permission bits. The writer refuses extended attributes it detects on Linux and macOS rather than silently stripping them. Windows ACLs and other platform-specific metadata are not verified by the Linux suite.
- The lock does not coordinate with external editors. Existing-file replacement is not atomic compare-and-replace: a save can still land after validation. These checks are not workspace confinement or defense against arbitrary concurrent directory changes.

Verification on Linux: **62 native tests passed**, including 12 new checks. The tests used real disposable files and a separate audit log. They verified the reviewed bytes on disk and through the Files reader, the hash chain and replay rejection, ordinary saves before apply and after staging, one winner for two competing approvals, no-clobber creation, unique stage cleanup, and Unix mode/link checks. The production frontend build and all 34 fixture checks also passed. Live Tauri window acceptance remains open.

## S11 — separate verification from recording health

- **Verify chain** distinguishes missing, empty, legacy-only, unreadable, broken, and consistent logs. An unreadable path or a record over the 1 MiB read limit does not produce a verification result. Malformed records and invalid links report the first break. The existing chain format and unhashed legacy prefix remain readable.
- A consistent check returns up to 25 recognized, checked outcomes, newest first. The desktop view gets only the record number, tool and outcome labels, and a formatted timestamp when available. It does not receive raw rows, commands, paths, contents, identities, or errors. Legacy records contribute to the counts, not the activity list.
- Native append failures are reported separately from tool outcomes. Audit-only IPC hooks return an error when the append fails. Other operations keep their actual results: an edit that already happened is not reported as failed or rolled back. The titlebar and Audit page show a warning retained for the current native process, including across renderer reloads. This pass does not make working audit storage an authorization precondition.
- Verification checks consistency of the available records, not audit coverage or storage durability. It cannot detect a complete suffix removed at a record boundary without an independent checkpoint. No trusted checkpoint was added.

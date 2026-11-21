# Pass 1 — native boundary hardening

First implementation pass from the system design review of 21 November 2026 (`AnyBot-system-design-review.md`). Goal: make the enforcement layer match what the interface promises before adding any new execution integrations.

## What changed

### S01 — mutation endpoints no longer accept an approval string
`execute_shell_command` and `write_file_content` ignore a renderer-supplied `decision: "approved"`. Every approval-required mutation must carry a single-use native proposal token bound to the exact command/path and content. (`src-tauri/src/commands/shell.rs`, `src-tauri/src/commands/fs.rs`)

### S02 — deny rules are now absolute
`deny_patterns` and `deny_commands` produce a new `CommandSafetyTier::Denied`. The shell endpoint refuses denied commands before proposal consumption, so no token, approval, or standing grant can run them. The agent loop mirrors this: a denied tool call is rejected outright with no proposal to approve. (`src-tauri/src/security.rs`, `src-tauri/src/commands/shell.rs`, `src/services/agent/agentLoop.ts`)

### S03 — vault saves fail closed
A keychain failure for any non-empty secret aborts the whole save: nothing is written, already-stored entries are rolled back to their previous values, and the caller gets an error naming the failing credential. Plaintext is never persisted as a fallback. Legacy migration in `load_vault_config` is per-field non-destructive: a field whose migration fails keeps its plaintext on disk (its only remaining copy) instead of being replaced by a placeholder. (`src-tauri/src/commands/vault.rs`)

### S04 — protected governance files are screened on the shell route
`command_touches_protected_path` screens shell commands for literal references to the config directory's governance files (`config.json`, `policy.json`, `standing-grants.json`, `audit.jsonl`), with `~` expansion, for both auto-run and approved commands. `env` and `printenv` were removed from the default read-only allowlist — bare `env` dumps the whole inherited environment into model context. Documented limit: this is string screening, not a sandbox; obfuscated or compound forms still require approval scrutiny. (`src-tauri/src/commands/fs.rs`, `src-tauri/src/commands/shell.rs`, `src-tauri/src/security.rs`, `src-tauri/src/policy.rs`)

### S05 — ACP/BYOP completion is the terminal event, not the launch ack
The adapter no longer treats `run_acp_prompt`'s spawn acknowledgement as completion. It waits for the native child-wait task's `finished`/`error` event (or an abort), keeps the abort listener attached until then, and drops events arriving after settlement. Stop now reaches a real kill while the CLI runs. (`src/services/ai/streamClient.ts`)

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

## Not in this pass

From the review's Pass 1 list: S06 (workflow step semantics — a failed tool must block dependent steps), S07 (human-input workflow gates), S09 (CLI context/tool-less delegation contract). S10 (workspace identity), S11 (audit observability), S13 (apply-time race), S14 (room authorship) remain open as Pass 2 candidates.

Desktop manual checks still outstanding: live proposal review → apply → audit verification flow, and the stale-file scenario between review and approval.

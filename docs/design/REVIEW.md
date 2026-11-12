# AnyBot repository review

**Reviewed:** 12 November 2026 (WIB)  
**Repository:** [ther12k/anybot](https://github.com/ther12k/anybot)  
**Commit:** [`ac5c88cc52736aceba56bd21867478f01db63f51`](https://github.com/ther12k/anybot/commit/ac5c88cc52736aceba56bd21867478f01db63f51)  
**Scope:** Product behavior, agent execution, permissions, provider clients, and implications for the UI/UX redesign.

## Assessment

AnyBot already connects a desktop conversation interface to useful local actions. The next design should make those actions understandable and controllable: which project is involved, which model receives the context, what change is proposed, and whether execution has actually finished. Its current permission and execution behavior needs correction before the interface can confidently promise that changes always require approval or that stopping has terminated work.

This review records findings; it does not claim that the original application has been fixed. The accompanying redesign is a separate interaction prototype. Proposed workspace restrictions, permission scopes, and review flows require production implementation.

## Evidence and verification boundaries

- **Source inspection:** Findings are tied to the exact commit above. Native behavior described below is inferred from the Rust implementation and relevant library contracts.
- **Four deterministic client probes:** Actual TypeScript was loaded through Node's type stripping, with imports supplied by in-memory stubs. These exercised provider error frames, tool-history serialization, transcript updates, and overlapping cancellation. They made no external AI requests and ran no host commands.
- **Frontend build:** PASS — npm ci --ignore-scripts followed by npm run build (TypeScript and Vite).
- **Native runtime:** Not executed. Rust and Cargo were unavailable in this environment. No packaged desktop, Windows process termination, real credentials, or live provider compatibility was tested.

Priorities describe implementation urgency, not a claim of a demonstrated remote exploit: **P1** affects permission, cancellation, or informed approval; **P2** affects correctness, recovery, and clarity.

### Deterministic probe results

| Probe | Observed result |
| --- | --- |
| Error frames in an HTTP-200 stream | All three provider parsers reported finished without reporting the simulated error. |
| Ollama request serialization | The captured assistant message omitted tool calls; the tool response retained only role and content. |
| Tool-state updates | A previously streamed explanation became empty when its tool entered running and completed states. |
| Stop, restart, settle previous run, Stop again | The previous signal was aborted; the new signal remained active after the second Stop. |

These probes isolate client behavior. They do not establish end-to-end desktop compatibility, provider availability, or the behavior of native commands on a supported operating system.

## What is already useful

The project separates provider streaming, agent orchestration, native commands, and presentation into recognizable modules. Four tool definitions provide a manageable initial scope: shell execution, reading, writing, and directory listing. [Tool definitions](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/services/ai/tools.ts#L1-L90)

Several implementation choices are worth preserving. Cloud providers receive their own credential rather than falling back to another provider's key. Missing-key errors include a recovery direction. Writes use a temporary file followed by rename. Unix commands are placed in a process group, and pending approval promises resolve when Stop is requested. These foundations need completion rather than a wholesale rewrite. [Provider credentials](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/services/ai/streamClient.ts#L260-L273), [file writes](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src-tauri/src/commands/fs.rs#L57-L64), [cancellation](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/services/agent/agentLoop.ts#L20-L32)

The UI also has practical touches: searchable and pinnable conversations, undo for deleted chats, explicit disabled states for unfinished attachment controls, and some reduced-motion handling. Keep these while improving context and hierarchy. [Sidebar](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/components/Sidebar/Sidebar.tsx#L43-L80), [undo](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/App.tsx#L154-L184), [composer](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/components/Composer/Composer.tsx#L134-L153)

## P1 findings

### 1. The read-only command classification accepts mutating commands

The evaluator checks command names and broad prefixes, not command semantics. The default policy permits `env`, `git branch`, `git remote`, and `git tag`; a standalone `&` is absent from the compound-syntax markers. Source tracing therefore classifies examples such as `env touch example.txt`, `git branch -D example`, `git remote remove origin`, and `ls & touch example.txt` as safe without confirmation. These examples were not executed. [Evaluator](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src-tauri/src/security.rs#L64-L111), [default policy](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src-tauri/src/policy.rs#L71-L113)

`cargo check` is also approved as inspection even though project build scripts can execute. The UI promise “Changes always ask first” consequently exceeds the implemented guarantee. [Policy phrases](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src-tauri/src/policy.rs#L93-L105), [UI promise](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/components/BotDrawer/BotDrawer.tsx#L190-L203)

**Recommendation:** Parse shell structure, validate allowed argument combinations, and require approval for unknown forms. Present classification as a specific action and reason, not a blanket assurance of safety.

### 2. Stop can lose control of a newly started turn

The UI enables sending immediately after Stop. A new turn can reuse the same `AgentLoop` before the previous turn settles. The old turn's `finally` then clears the shared controller belonging to the newer turn. [Stop handler](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/App.tsx#L295-L298), [shared state](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/services/agent/agentLoop.ts#L11-L49), [cleanup](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/services/agent/agentLoop.ts#L211-L215)

**Probe result:** Start A, stop A, start B, settle A, stop B. A's signal was aborted; B's signal remained un-aborted after the second Stop.

**Recommendation:** Give each run its own controller, approval registry, and execution identity. Cleanup must affect only its owning run. Display `Stopping…` until termination is confirmed, with an honest pending state if termination cannot be verified.

### 3. A shell timeout does not terminate the tracked process

The executor wraps `wait_with_output()` in a timeout and unregisters the PID before handling the timeout result. The error branch records a timeout and returns, without killing the process group or waiting for termination. No `kill_on_drop` configuration is present. [Executor](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src-tauri/src/commands/shell.rs#L130-L181)

Tokio documents that dropping a child handle leaves the process running by default. This makes continuing work after the reported timeout a source-supported concern; it was not reproduced in a native runtime here. Windows cancellation is explicitly unsupported by the current kill implementation. [Tokio cancellation contract](https://docs.rs/tokio/latest/tokio/process/), [Windows branch](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src-tauri/src/commands/shell.rs#L91-L95)

**Recommendation:** Timeout must terminate and reap the entire process tree before the app reports a confirmed stop. Keep the execution discoverable until cleanup finishes.

### 4. Write approval provides no proposed-content preview

The agent requests write approval before reading the original content. It creates the diff only after the write finishes. While waiting, the tool card displays the path and a generic reason, with no proposed contents. [Approval and write ordering](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/services/agent/agentLoop.ts#L245-L268), [post-write diff](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/services/agent/agentLoop.ts#L337-L359), [tool card](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/components/Chat/ToolCard.tsx#L143-L200)

**Recommendation:** Show the exact proposed diff, destination, and creation/overwrite status before approval. Bind approval to the proposed content and original version; if either changes, refresh review. Distinguish `Review changes`, `Apply once`, and `Applied` in both the interface and data model.

## P2 findings

### 5. Selecting a conversation does not restore its agent context

Threads record a `botId`, but selecting a thread only sets `activeThreadId`. Sending uses the globally active bot and selected model. Switching personas also leaves the current thread selected. A user can therefore reopen one agent's conversation and continue it under another agent's instructions. [Thread creation](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/App.tsx#L141-L151), [selection](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/App.tsx#L192-L196), [execution](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/App.tsx#L263-L268), [thread handler](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/App.tsx#L356-L362)

**Recommendation:** Persist and restore persona, model, and workspace per conversation. Make a context change explicit, especially before transmitting earlier history to a different provider.

### 6. “Local Offline Agent” is a persona label, not an enforced privacy mode

Its description promises fully local operation, while the composer permits choosing any provider. Requests follow the selected model. The label can therefore remain local while the conversation uses a cloud API. A configurable Ollama endpoint is also not necessarily loopback. [Persona](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/data/defaultBots.ts#L334-L359), [model selector](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/components/Composer/Composer.tsx#L89-L108), [routing](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/services/ai/streamClient.ts#L62-L69)

**Recommendation:** Derive Local/Cloud status from the effective connection. Explain a transition to cloud before sending existing context; reserve stronger privacy claims for an enforced mode.

### 7. Default starter tasks require tools that the default model disables

The default Grok persona selects `phi3:mini`, whose declared capability is `supportsTools: false`. Its starters nevertheless offer workspace inspection, diagnostics, and writing/running code. The Ollama client correctly omits tools for this model, so the onboarding promise and payload disagree. [Defaults](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/data/defaultBots.ts#L5-L31), [model capability](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/services/ai/models.ts#L58-L64), [payload](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/services/ai/streamClient.ts#L426-L435)

**Recommendation:** Check connection and capabilities before presenting executable starters. Offer a compatible model or a clearly labeled chat-only mode. Separate persona identity from model/provider identity.

### 8. Visible agent controls do not affect execution

The drawer saves per-agent temperature and auto-approval settings. Execution reads only the global vault auto-approval flag and explicitly ignores the bot argument. None of the provider payloads sends the persona temperature. [Controls](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/components/BotDrawer/BotDrawer.tsx#L159-L219), [effective permission](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/services/agent/agentLoop.ts#L232-L252), [provider payloads](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/services/ai/streamClient.ts#L148-L162)

**Recommendation:** Define one effective permission setting or explicit precedence. Wire supported controls into requests; hide unsupported controls instead of saving ineffective preferences.

### 9. Tool updates erase previously streamed explanations

Tool-state updates spread the original empty assistant entry. The application replaces the stored entry with that object. The probe observed the explanation change from “I will inspect this file.” to an empty string when the tool became running and completed. [Update callback](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/services/agent/agentLoop.ts#L164-L169), [entry replacement](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/App.tsx#L269-L276)

**Recommendation:** Preserve accumulated content and thinking when applying status changes. Conversation content should remain stable while a separate activity area updates.

### 10. Provider errors and incomplete results can look finished

With simulated HTTP-200 error frames, Anthropic, OpenAI-compatible, and Ollama clients each called `onFinished` without an error callback. Their parsers ignore the error shapes. The inactivity timeout also intentionally becomes a successful finish, potentially leaving an incomplete answer unlabeled. [Anthropic parser](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/services/ai/streamClient.ts#L202-L248), [OpenAI parser](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/services/ai/streamClient.ts#L337-L396), [timeout handling](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/services/ai/streamClient.ts#L71-L83)

A separate payload probe confirmed Ollama history loses assistant tool calls and tool-result identifiers/names. [Ollama history mapping](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/services/ai/streamClient.ts#L410-L423)

**Recommendation:** Preserve provider tool protocols and model explicit `Completed`, `Interrupted`, `Failed`, and `Cancelled` outcomes. Keep partial text with a recovery action. Character animation should follow these states rather than suggest success independently.

## Trust boundaries and remaining hardening

Native execution currently trusts a frontend-supplied decision string; the shell endpoint does not repeat policy evaluation, and writes default a missing decision to `approved`. This is an architectural trust gap, not evidence of an observed remote exploit. File tools accept unrestricted paths, and their results enter the next model request. A project label must not imply filesystem confinement until native checks enforce it. [Shell entry point](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src-tauri/src/commands/shell.rs#L49-L59), [file access](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src-tauri/src/commands/fs.rs#L8-L48), [model history](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src/services/agent/agentLoop.ts#L72-L79)

Keys are stored as plain JSON, already disclosed in the README. An unrestricted read can include that configuration in model context. Use OS credential storage and protected-path handling before calling this a secure vault. Standing grants also need project scope and case-sensitive command identity: the current comparison ignores case and stores no working directory. [Key storage](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src-tauri/src/commands/vault.rs#L29-L37), [grant matching](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src-tauri/src/security.rs#L74-L83)

## README claims to reconcile

| Claim | Review finding |
| --- | --- |
| React 19 | The manifest declares React and React DOM 18.3.1. |
| AST-based command categorization | The reviewed evaluator uses strings and prefixes. |
| Diff before writing | The current diff is constructed after writing. |
| Every tool decision/outcome is audited | Reads and directory listing lack audit calls; file-write failures return before the success audit. |
| Immediate Stop of process trees | Windows is unsupported; timeout handling and overlapping-run cancellation need correction. |
| Approximately 25 MB and subsecond startup | No reproducible benchmark evidence was found in the reviewed source; performance was not measured. |

Sources: [README overview](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/README.md#L3-L18), [governance claims](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/README.md#L100-L107), [package manifest](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/package.json#L12-L22), [filesystem implementation](https://github.com/ther12k/anybot/blob/ac5c88cc52736aceba56bd21867478f01db63f51/src-tauri/src/commands/fs.rs#L7-L118).

## Recommended implementation order

1. **Make execution reliable:** enforce native authorization, correct command classification, implement process-tree timeout cleanup, and isolate cancellation per run. Add focused regression cases for the demonstrated failure paths.
2. **Make approval informed:** prepare diffs before execution, bind consent to exact changes, show full paths and working directories, and provide scoped permission management.
3. **Make context accurate:** restore conversation identity, distinguish persona from provider, check model capabilities, and derive Local/Cloud indicators from effective routing.
4. **Make outcomes honest:** preserve transcript text, handle provider errors, retain structured tool history, and implement interruption/retry states.
5. **Apply the redesigned interface and character:** keep current work central, make pending decisions easy to find, and connect motion to real state. Preserve reduced-motion behavior and textual status labels.
6. **Validate claims:** run native tests on supported platforms, exercise real provider contracts with controlled credentials, measure performance, and revise the README to match verified behavior.

The redesign can make these relationships clear now. Production acceptance should depend on the underlying behavior meeting the same promises.

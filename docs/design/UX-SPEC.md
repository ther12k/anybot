# AnyBot UI/UX redesign — implementation handoff

**Date:** 12 November 2026 · **Review baseline:** `ac5c88cc52736aceba56bd21867478f01db63f51` · **Character:** Tavi

## 1. Deliverable boundary and implementation status

This deliverable is a standalone browser prototype for reviewing AnyBot's proposed interface and live SVG character. Agent responses, model connections, workspace selection, file reads and writes, command execution, approvals, checks, and completion results are simulated. A successful demonstration in this prototype does not establish that the corresponding native operation works or is secure.

The reviewed AnyBot source repository is unchanged. The defects described below remain findings against the baseline until separately fixed and verified in the Tauri application. The prototype's presentation of a proposed feature must not be described as a completed backend fix.

| Area | Prototype contract | Native application requirement before shipping |
| --- | --- | --- |
| Navigation | Browser views demonstrate Home, Tasks, Agents, Activity, and Settings. | Bind views to real persisted records and permission-aware native services. |
| Tasks and chat | Demonstration conversations and deterministic state transitions communicate the workflow. | Real provider streaming, stable thread identity, cancellation, and durable storage. |
| Workspace | A displayed path supplies scenario context. It is not a filesystem sandbox. | Canonical workspace identity, path validation, and backend enforcement of whatever scope the interface promises. |
| Model selection | Choices illustrate model/provider context. A connected label in the demonstration is sample state. | Runtime connection checks, discovered models, verified capabilities, and accurate transport labels. |
| Approvals and diffs | The user can inspect a proposed change and demonstrate approve/reject behavior. No local file is changed. | Generate the proposal before execution, bind approval to that exact proposal, and reject stale or altered proposals. |
| Activity | Sample task/run events show the intended hierarchy. | Render actual persisted events with provenance and reliable outcomes. |
| Tavi | A live SVG responds to demonstration state through ten supported moods. | Bind its mood to the same authoritative run state as the status text. |
| Settings | Demonstrates controls and visual preferences. | Persist real settings safely; show controls only when they affect execution. |

Keep a concise, visible **Interactive prototype · simulated actions** label in the demonstration. Do not ask for or store real API keys in it. Do not present fake terminal output as a live execution result. The prototype must remain useful without external provider access.

## 2. Product direction

AnyBot is a desktop assistant that can act on files and commands. Its interface should let the user answer four questions quickly: what task is active, what the agent is doing, what needs a decision, and what actually changed.

Use a warm paper surface, restrained coral accents, readable ink text, and sage details. Give the assistant a distinct AnyBot identity. Agent templates describe working styles; provider/model selection describes the execution engine. These concepts should remain visually and structurally separate.

Tavi is a quiet companion within the work surface. It supplies recognition and a supplementary state cue. It should not compete with the requested task, hide an error, or celebrate an unverified result.

### 2.1 Task-first information architecture

| View | Primary purpose | Primary content and action |
| --- | --- | --- |
| **Home** | Start useful work with clear readiness. | Tavi, task composer, current workspace, provider/model readiness, and a few capability-compatible starter tasks. Primary action: start a task. |
| **Tasks** | Continue or inspect work. | Named conversations, active and recent runs, explicit status, search, and pinned items. A task is a conversation and its runs; this design does not imply a scheduler or parallel workers. |
| **Agents** | Choose or configure a working style. | Instruction templates, role descriptions, compatible capabilities, default model preference, and custom agent configuration. Use “Agent library,” not “Marketplace,” until a marketplace exists. |
| **Activity** | Understand what happened. | Task-scoped events, approvals, reads, changes, execution results, failures, and timestamps. Summaries open evidence rather than inventing activity. |
| **Settings** | Configure and inspect the application. | Providers, execution policy, standing grants, appearance/motion, and stored-data recovery. Advanced controls appear only when connected to runtime behavior. |

The active conversation remains the main working surface. Use an optional run-details panel for steps and outputs. A dedicated change-review surface holds the approval decision and full diff. Avoid turning the default conversation into a wall of expanded terminal logs.

### 2.2 Home and first-run readiness

Home should show one useful next action for the current readiness state:

- **No provider configured:** connect a provider or configure a local endpoint.
- **Endpoint not checked:** offer a connection check; do not infer availability from a saved URL.
- **Connected, chat-only model:** offer writing and analysis prompts, and explain that file/command actions require a tool-capable model.
- **Connected, tool-capable model:** offer workspace inspection, code review, and a reviewed edit.
- **Connection failed:** show the failed provider/endpoint and a concrete retry or settings action.

Do not preselect filesystem prompts under a model marked `supportsTools: false`. Model readiness and filesystem access are separate facts; both must be true before presenting an executable task as ready.

### 2.3 Conversation layout

Keep the following context visible above or adjacent to the conversation: task title, workspace, agent, selected model/provider, and current run status. The composer shows the active capability mode and a clear Send or Stop control. Ordinary submissions and starter prompts must pass through the same run-start guard.

An approval waiting in another task needs a persistent navigation cue. Navigating away must not make a live operation undiscoverable. If the supported execution policy allows only one run, preserve that limitation explicitly instead of implying multiple runs can operate safely.

Autoscroll only while the reader is near the bottom. If the reader has moved up, preserve their position and show a **New activity** or **Jump to latest** action. Use incremental or debounced persistence so every streaming token does not serialize the complete history synchronously.

## 3. Data, context, and execution contracts

### 3.1 Immutable task and run context

A thread owns its agent, provider/model, and workspace context. Selecting another thread restores that thread's context; it must not reuse whichever agent happens to be globally selected. Historical messages retain the identity and execution context of the run that produced them.

Recommended records:

| Record | Required context |
| --- | --- |
| Thread | Stable ID, title, agent reference plus saved instruction revision, provider/model reference, canonical workspace reference, created/updated timestamps. |
| Run | Stable run ID, thread ID, immutable context snapshot, status, start/end timestamps, cancellation state, and result summary. |
| Message | Stable ID, thread/run ID, role, content, producing agent/model snapshot where applicable, and timestamp. |
| Proposal | Stable proposal ID, run ID, action type, exact normalized path or command plus working directory, before/after data or reviewed arguments, content/version fingerprint, and decision state. |
| Activity event | Run and tool-call identity, actual action, decision provenance, terminal outcome where known, and timestamp. |

Changing agent, provider, or workspace should start a new task or an explicit fork with its own context. A cosmetic global selection must never rewrite history or silently change the next turn of an existing task. At minimum, every run must preserve its own immutable snapshot while a migration strategy is implemented.

### 3.2 Accurate data-boundary labels

Derive locality from the actual provider and configured endpoint, not from the agent name, character mood, or a static description.

| Actual configuration | Appropriate label | Avoid |
| --- | --- | --- |
| Verified local Ollama endpoint | **Local model · [model name]** | An unconditional claim that all app activity is offline. |
| Ollama endpoint on another host | **Remote endpoint · [host]** | Calling every Ollama connection local. |
| Cloud provider | **Cloud model · [provider]** | Keeping an “offline/private” badge because a local persona is selected. |
| Saved but unchecked endpoint | **Connection not checked** | “Detected locally” or “Connected.” |
| Failed or unavailable connection | **Connection unavailable** with recovery action | Treating a lost connection as successful completion. |

State clearly when the selected provider receives prompts, conversation history, and file/tool output used for the request. A local model label is not a guarantee about shell commands, downloaded dependencies, or other network-capable tools. The mockup illustrates these labels; native code must supply the underlying facts.

### 3.3 Dedicated approval and diff review

Use a change-review dialog or full review panel with a clear task reference. Present, in order:

1. The intended outcome in plain language.
2. Exact action target: filename and canonical workspace, or command and working directory.
3. The proposed change with additions, removals, line numbers, and expandable unchanged context.
4. Scope and decision consequences.
5. **Apply change** or **Run once**, plus **Reject**.

The proposed diff must exist before the user approves. “Applied” and “Created” are terminal result labels, not proposal labels. Keep full proposed content available when a diff is not meaningful, such as a new file or unsupported binary format.

Do not approve a proposal that has changed since review. Native execution must compare the reviewed version/fingerprint with current state and return the user to review if it differs. Approval must authorize the same target, working directory, arguments, and content that were displayed.

Standing grants are a separate persistent decision. Show the exact grant scope, avoid making it the default approval action, and provide an inspect/revoke route in Settings. The interface must reflect the backend's deny rules and grant behavior accurately; a friendly button is not enforcement.

For narrow screens or windows, keep the decision controls reachable while the diff itself scrolls. Do not truncate the only explanation of a potentially consequential action.

### 3.4 Authoritative run states

The following are product states, not direct aliases for character moods. Every state has a readable text label. Completion requires terminal evidence; a stream ending unexpectedly is not proof that work completed.

| State | Meaning / entry condition | Text and available action | Tavi mood |
| --- | --- | --- | --- |
| `idle` | No live run. | **Ready**; start a task. | `idle` |
| `thinking` | Provider is processing or streaming a response; no filesystem change is implied. | **Working on your request**; Stop. | `thinking` |
| `reading` | A verified read/list operation is in progress. | **Reading [target]**; Stop where supported. | `working` |
| `approval` | A complete immutable proposal awaits a user decision. | **Waiting for your review**; review, approve once, reject, or stop. | `approval` |
| `applying` | An approved change is being executed. | **Applying approved change**; expose supported stop behavior without promising rollback. | `working` |
| `verifying` | Requested checks are running against the resulting state. | **Running checks** with actual check name; Stop. | `working` |
| `completed` | Required operations and checks reached the defined successful outcome. | **Completed** with evidence and changed files; inspect results. | `success` briefly, then `idle` |
| `interrupted` | Response/operation ended unexpectedly with incomplete evidence, including an idle stream timeout. | **Response interrupted**; preserve partial output; offer a safe retry/continue path. | `error` |
| `error` | A provider, tool, validation, or persistence failure is known. | Specific failure and recovery action; preserve completed work and its evidence. | `error` |
| `stopping` | Cancellation was requested and acknowledgments are pending. | **Stopping…**; avoid accepting a conflicting run until state is settled. | `working` with motion reduced or stopped |
| `stopped` | The run has stopped and relevant tool termination is acknowledged. | **Stopped by you**; identify any completed changes and allow a new request. | `idle` |

Typical path: `idle` → `thinking` → `reading` → `approval` → `applying` → `verifying` → `completed`. A task may skip irrelevant stages. Failure can occur at every stage. Stop requests route through `stopping`; they do not immediately claim that a native process has terminated.

Rejecting a proposal produces a rejected action event. Whether the conversation continues with an alternative is an explicit run policy. A refusal to apply a change must never be rendered as a successful applied change.

## 4. Visual system and Tavi

### 4.1 Core tokens

```css
:root {
  --paper: #FAF8F5;
  --coral: #D86A4F;
  --ink: #322D29;
  --sage: #697C65;
  --coral-text: #9C402C;
}
```

| Token | Intended use |
| --- | --- |
| `--paper` | Main canvas and calm background. |
| `--coral` | Brand accent, character detail, selection accents, and nontext emphasis. |
| `--ink` | Main text, essential labels, and high-contrast primary controls. |
| `--sage` | Supporting illustration details and restrained secondary emphasis. |
| `--coral-text` | A darker derived accent for normal-size text where coral is needed. |

Calculated solid-color contrast ratios on paper are approximately **12.84:1 for ink**, **3.25:1 for coral**, and **4.24:1 for sage**. White on base coral is approximately **3.45:1**. Therefore base coral and sage are not default normal-size text colors. Use ink for normal text and choose a darker accent for colored labels; `--coral-text` on paper is approximately **6.22:1**. Recheck actual rendered controls, including hover, selected, disabled, translucent, and dark-mode variants.

Use clear type hierarchy and generous task-area spacing. Keep metadata secondary without making it tiny. Reserve the strongest control treatment for the immediate action. Approval and error semantics must use text/icons in addition to color.

### 4.2 Tavi character contract

Tavi is an original peach/coral companion with a soft asymmetrical body and a small leaf-like crest. Its live SVG changes pose and facial details rather than swapping unrelated raster illustrations. It remains recognizable in the sidebar, conversation, and larger welcome state.

The supplied browser character exposes `AnyBotCharacter.svg(mood, size, id)` and `AnyBotCharacter.moods`. The SVG has a `160 × 160` viewBox; instance-specific gradient IDs prevent collisions when several characters appear on one page. Preserve unique IDs in any React conversion.

| Supported mood | Appropriate use |
| --- | --- |
| `idle` | Ready or settled state; restrained breathing/blinking. |
| `listening` | Composer engagement or attentive state. This does not claim a microphone/voice feature exists. |
| `thinking` | Provider processing or task planning. |
| `working` | A real or clearly simulated operation is in progress. |
| `approval` | Waiting for the user's review; attention without pressure. |
| `success` | Brief acknowledgment after verified success. |
| `error` | Failure or incomplete response paired with recovery text. |
| `sleep` | Decorative inactive/paused presentation; never hide an active run. |
| `wave` | Welcome or an optional character demonstration. |
| `offline` | Connection unavailable/disconnected presentation. This is not a privacy guarantee and is not the normal mood of a healthy local model. |

Use the run-state table to map product state to mood. The ten moods need not correspond one-to-one to the eleven product states. Keep mood selection in a dedicated character demonstration separate from execution state so manually previewing a mood cannot falsely change task status.

### 4.3 Accessibility and motion

- Text is authoritative. Character expression, animation, and color are supplementary.
- Honor `prefers-reduced-motion: reduce`: stop decorative loops and use static poses without losing status information.
- Mark decorative SVG instances `aria-hidden="true"` and nonfocusable. Give status text its own accessible semantics; do not repeatedly announce facial animation.
- Use native `<dialog>` with an accessible title for modal reviews/settings. Move focus when the dialog actually opens and return it to its trigger when it closes. Avoid effects that refocus on every streaming render.
- Keep keyboard focus visible, including controls normally exposed on hover. Escape closes a dismissible modal; rejecting/stopping an operation remains a distinct action.
- Preserve content reading position during streaming. Announce meaningful status transitions rather than every token.
- Keep approval actions reachable at reduced window sizes and zoom. Use touch/click targets large enough to operate comfortably.
- Scope loading/error announcements to the relevant region and make retry actions explicit. Do not automatically repeat a file write after a connection failure.

## 5. Ordered implementation tasks

These tasks are proposed native implementation work. None is marked fixed by the prototype. They intentionally address specific baseline defects rather than adding unrelated features.

| ID | Task | Depends on | Meaningful acceptance criteria |
| --- | --- | --- | --- |
| **UX-01** | Define immutable thread/run context and producing-message identity. | — | A thread records agent revision, provider/model, and workspace. A run snapshots those values. Historical message identity is read from its producing run, never the global selection. |
| **UX-02** | Migrate and validate stored conversations. | UX-01 | Malformed thread/transcript JSON yields a recoverable screen rather than an app crash. Legacy records migrate without silently changing agent identity. Save failures are visible and preserve in-memory work. |
| **UX-03** | Centralize run start and enforce the supported concurrency policy. | UX-01, UX-02 | Composer submit, starter prompts, keyboard shortcuts, and retry all use the same guarded start path. Starting a task, opening a new task, and clicking a starter cannot create overlapping runs on one shared controller. |
| **UX-04** | Implement complete stop and task-deletion lifecycle. | UX-03 | Stop transitions through `stopping` until relevant acknowledgments arrive. Pending approvals settle. Deleting an active task cannot leave an undiscoverable running operation or recreate orphan transcript entries. |
| **UX-05** | Add provider readiness, model capability, and data-boundary facts. | UX-01, UX-02 | Saved endpoints start unchecked. A successful check yields actual available models. Chat-only models do not offer executable starter tasks. A remote endpoint/cloud model never retains an unconditional local/offline claim. |
| **UX-06** | Align global/agent permissions and persistent grants with backend enforcement. | UX-01 | Define and implement precedence explicitly. Changing an agent's permission control demonstrably changes the effective policy or the control is removed. Grant scope is inspectable/revocable; deny rules remain enforced. |
| **UX-07** | Generate immutable proposed changes before approval. | UX-03, UX-06 | A write proposal contains the exact target and before/after data before the approve action appears. Reject writes nothing. Approve writes only the reviewed proposal. A file changed after review forces re-review. |
| **UX-08** | Repair diff rendering and implement the dedicated review surface. | UX-07 | A file with more than eight consecutive unchanged lines exposes a working context-expansion control. New files show proposed content. Review clearly distinguishes proposed/applied/failed and keeps decisions reachable. |
| **UX-09** | Preserve stream content and represent terminal outcomes honestly. | UX-03, UX-04 | Tool status updates do not erase previously streamed assistant content. Idle timeout/incomplete response becomes `interrupted`, not `completed`. Failure and stopped states preserve evidence of work already done. |
| **UX-10** | Bind task navigation and activity to the real records. | UX-01, UX-03, UX-07, UX-09 | Switching tasks restores the correct context. A pending decision remains discoverable. Activity events link to their run and actual outcome. No simulated event is shown in production mode. |
| **UX-11** | Remove inert settings or wire them end-to-end. | UX-05, UX-06 | Temperature affects a supported provider request or is absent. Model choice persists in the correct context. Static capability lists become capability-aware. No hardcoded “detected” status remains. |
| **UX-12** | Fix streaming focus, scrolling, and persistence behavior. | UX-02, UX-10 | Editing an open drawer during token updates retains focus. Reading earlier messages retains scroll position. Streaming does not serialize all history on every token. Keyboard users can reach and identify all controls. |
| **UX-13** | Integrate Tavi and the visual system with real application state. | UX-09, UX-10, UX-12 | Moods follow authoritative state. Success appears only after verified success. Reduced motion preserves all textual states. Multiple SVG instances have no gradient-ID collision. Normal text/control contrast is verified. |

Recommended sequence: establish data and lifecycle first (**UX-01–04**), connect readiness and policy (**UX-05–06**), then implement reviewed changes and trustworthy outcomes (**UX-07–09**). Build navigation and settings on those contracts (**UX-10–11**), finish interaction behavior and character integration (**UX-12–13**). Independent implementation may proceed in parallel only where the dependency column permits it.

## 6. Backend dependencies and release evidence

Before using this interface to communicate real native execution, resolve the following dependencies:

- **Enforced execution context:** exact workspace/path, command working directory, proposal scope, and effective policy must be validated by the native layer. A displayed workspace chip alone does not confine execution.
- **Pre-execution proposals:** provide a real proposal API and version/fingerprint check; the existing after-write diff cannot satisfy the review contract.
- **Single-run ownership or explicit concurrency:** cancellation controllers, pending approvals, shell calls, transcript callbacks, and terminal status must belong to a run.
- **Reliable tool outcomes:** expose stopping/stopped/error/interrupted separately from success and preserve partial results. A canceled stream does not itself prove a child process stopped.
- **Provider facts:** actual discovery/health results, tool capability, and selected endpoint drive UI claims. Avoid treating static model metadata as a successful connection check.
- **Durable records and secrets:** validate persisted records, report write failures, and use an appropriate secret-storage implementation for production credentials. Prototype storage is not a credential vault.
- **Activity provenance:** bind decisions and outcomes to actual native events, not generic demonstration timers.

Release evidence should exercise the concrete risks above: switching threads with different agents; starting via a prompt while another run exists; stopping during provider/tool/approval stages; rejecting and applying a reviewed edit; changing a file between review and apply; browsing long diff context; missing/remote/local provider states; interrupted streaming; corrupt persisted data; and keyboard/reduced-motion behavior. Test these scenarios against the native application with controlled fixtures. Do not infer their success from the browser mockup.

## 7. Source evidence for the baseline findings

All references below are to the reviewed commit, not a moving branch. Line references support the review findings; the proposed design above is a recommendation.

| Finding | Baseline evidence |
| --- | --- |
| Global agent used for existing thread/history | `src/App.tsx:192–196`, `263–268`, `362`, `446–450`; `src/types/index.ts:77–84`. |
| Alternative send path bypasses composer guard | `src/components/Composer/Composer.tsx:53–55`; `src/App.tsx:223–263`, `416–419`. |
| Shared run state / immediate stop flag | `src/services/agent/agentLoop.ts:11–32`, `46–49`; `src/App.tsx:295–298`. |
| Running task can be deleted while callbacks remain | `src/App.tsx:154–172`, `281–285`. |
| Proposed diff unavailable at approval time | `src/components/Chat/ToolCard.tsx:157–200`; `src/services/agent/agentLoop.ts:337–358`. |
| Unreachable unchanged-context expansion control | `src/components/Chat/DiffViewer.tsx:102–108`, `132–146`. An isolated check with 12 unchanged lines produced six hidden rows and zero expansion controls. |
| Agent-level permission preference ignored | `src/components/BotDrawer/BotDrawer.tsx:190–218`; `src/services/agent/agentLoop.ts:241–252`. |
| Inert temperature control | `src/components/BotDrawer/BotDrawer.tsx:53–62`, `159–181`; `src/services/agent/agentLoop.ts:105–141`; `src/services/ai/streamClient.ts:54–60`, `148–155`, `294–299`, `428–435`. |
| Default prompts mismatch tool capability | `src/data/defaultBots.ts:12–32`; `src/services/ai/models.ts:58–64`; `src/services/ai/streamClient.ts:426–435`. |
| Hardcoded detected-model claim | `src/components/SettingsModal/SettingsModal.tsx:220–223`. |
| Offline claim independent of selected transport | `src/data/defaultBots.ts:334–359`; `src/components/Composer/Composer.tsx:89–116`; `src/App.tsx:263–268`. |
| Corrupt-data startup risk and token-by-token serialization | `src/App.tsx:45–55`, `127–129`. |
| Forced scroll and drawer focus during updates | `src/App.tsx:131–138`, `474–476`; `src/components/BotDrawer/BotDrawer.tsx:40–49`. |
| Model read without corresponding selector persistence | `src/App.tsx:107–110`, `467`. |
| Tool updates can overwrite streamed prose | `src/services/agent/agentLoop.ts:91–100`, `164–169`. |
| Idle timeout treated as a graceful finish | `src/services/ai/streamClient.ts:71–79`. |

Repository baseline: [ther12k/anybot at ac5c88c](https://github.com/ther12k/anybot/tree/ac5c88cc52736aceba56bd21867478f01db63f51).

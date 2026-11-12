# Validation record

Date: 12 November 2026 (Asia/Jakarta).
Reviewed original repository: `ther12k/anybot`, commit `ac5c88cc52736aceba56bd21867478f01db63f51`.

## Original repository

- `npm ci --ignore-scripts --no-audit --no-fund`: completed.
- `npm run build`: TypeScript and Vite production build passed (1,857 modules).
- `git status --short`: clean after review/build. Original source remains unchanged.
- Four in-memory probes exercised the original TypeScript with stubbed network/desktop bridges: provider error frames, assistant text preservation during tool updates, Stop/new-run lifecycle, and Ollama history serialization. See REVIEW.md for findings. No live provider was called.
- Native Rust/Tauri execution, process termination, platform installers, and live model compatibility were not tested. Rust/Cargo are not installed in this review environment. Native findings are source analysis, with Tokio cancellation semantics checked in its primary documentation.

## New prototype and character

- Browser scripts passed `node --check`.
- React character passed strict TypeScript compilation with React 18 types, no emit.
- All ten SVG states parsed; unique IDs and invalid-mood fallback checked.
- Desktop browser review covered home, pre-write diff, unchanged-line expansion, Apply/verification/completion, stop/stopping/stopped, task-context retention, interrupted response, character selection, and light/dark themes.
- A task opened from the seeded OpenAI/notes conversation retained OpenAI/notes when a new sample was submitted.
- Selecting the chat-only sample model disabled file-exploration and file-edit starter actions.
- Responsive UI was inspected in a 390px iframe. Main content clientWidth and scrollWidth both measured 380px after the SVG sizing fix: no horizontal content scrolling.
- Mobile navigation and context panels moved keyboard focus into the opened panel and removed the background controls from interaction; current panel buttons expose expanded state.
- Reduced motion is implemented in both app and character styles; manual motion toggle is available. This is not a complete WCAG audit.
- Screenshot previews contain only synthetic/sample content.

## Limits

All executions, file edits, model capability states, connection status, and folder selections in the mockup are simulations. The prototype does not fix or validate the original native safety issues. Its review screen demonstrates the required future behavior. Production integration requires the ordered dependencies in UX-SPEC.md.

# Warm-paper workspace

The React desktop app uses the layout and styling from `AnyBot.html`. The prototype's script, example conversations, and scenario switcher are not part of the app. The existing Tavi component is used in the workspace rail, empty states, and run inspector.

## Run it

- `npm run tauri dev` opens the desktop app with its local configuration and native tools.
- `npm run dev` opens the browser preview. The browser has the bridge's development doubles, not access to native files, audit verification, CLI detection, or API-key storage. Use a configured local model to chat in this mode.

## What to try

1. **Chats:** Start a chat, then switch agents or models after a reply. AnyBot creates a separate fork containing text, not tool history, provider thinking, or approval tokens. The source chat stays unchanged.
2. **Review:** In a throwaway workspace with a tool-capable model, ask for a small edit to a disposable text file. Open the proposed diff or full file. Request changes to send feedback without applying the proposal, or approve to apply exactly the reviewed change. To check a stale proposal, change the disposable file outside AnyBot between review and approval; the native proposal layer should refuse the write.
3. **Files and Audit:** In the desktop app, open **Files** to preview the result, then **Audit log → Verify chain**. Files previews visible top-level workspace text files only, up to 256 KB and 400 lines. Audit shows the native integrity result; the bridge does not expose raw audit rows or audit export.
4. **Team Rooms and Workflows:** Create a room with two or more agents. The first selected agent is the default; mention up to three agents to ask them in order. Workflows run each step in the same conversation and stop on failure or cancellation. The conversation is kept in Chats; separate workflow run metadata is session-only.

## Verification

- `npm run build` — TypeScript and Vite production build passed.
- `cargo test --offline --manifest-path src-tauri/Cargo.toml --no-default-features` — 42 tests passed.
- `git diff --check` — passed.
- Browser checks at 1440 × 900 and 390 × 780 covered the workspace shell, secondary-page navigation, room creation, and responsive layout. An isolated build with a fixture response stream and the browser bridge double covered a README proposal, approve/apply UI, revision feedback, model forking, a three-step workflow, and Stop. These checks did not call a provider or modify real files. Live Tauri UI and the stale-file scenario remain desktop manual checks.

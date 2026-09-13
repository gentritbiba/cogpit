# Tool call rendering

The web timeline shares tool-call components across desktop, Electron, and mobile browsers. Agent-specific parsing happens before presentation; normalized calls use the same operation names and disclosure structure. Native iOS uses the same operation meanings with its own SwiftUI controls.

## Shared web structure

- Each row shows an operation icon, a readable action name, and a separate target or description. Summaries stay bounded to two lines even when details open. The complete command or input remains available below.
- Completed calls have a quiet check; running, failed, and missing-result states have explicit labels. Status is included in the disclosure’s accessible description. Hook timing and replaced-output metadata remain visible.
- An activity group has one count and a normalized operation breakdown. It exposes running, failure, and missing-result counts while collapsed. Consecutive shell calls remain separate chronological rows, each with its own disclosure.
- Automatically opened live groups keep the latest three individual entries plus all pending and failed calls. Earlier entries can be revealed together. Explicit collapse wins over automatic opening; navigation to a call reveals its group. Thinking and question history retain their place.
- Opening a call shows its useful input and result. Ordinary commands show complete wrapping command text and an output preview immediately. Sectioned shell scripts keep one output disclosure per section with output. Global expansion preserves the user’s prior section choices.
- A detected failure inside a sectioned shell script appears in the row status and group count, even when a later shell command succeeded. Arbitrary tool text is not classified as a shell failure.
- File changes, plans, questions, and agent messages retain structured details.
- Calls with structured details keep original input and script source behind an explicit “Raw input” disclosure. Unknown calls and scripts without recoverable nested operations fall back to formatted input or source. Expanding all payloads does not expand the separate raw-input disclosure.
- Long output has a bounded preview and a control to reveal the complete value. Empty completed output is distinct from a call that is still running.
- An edit failure must show its error even when the proposed diff is available.
- Images remain images and can be opened independently of text output. On the web, persisted result images take precedence over a local-file preview for image reads.
- Phone layouts keep summaries within the available width and use touch-sized controls. Long file paths must not squeeze short operation names out of the header.

## Operation names

| Input tool | Display name |
| --- | --- |
| `Bash`, `exec_command` | Run command |
| `Read` | Read file |
| `view_image` | View image |
| `Write` | Write file |
| `Edit` | Edit file |
| `Grep` | Search files |
| `Glob` | Find files |
| `Task`, `Agent`, `spawn_agent` | Spawn agent |
| `SendMessage`, `send_message` | Message agent |
| `TodoWrite`, `update_plan` | Update plan |
| `WebFetch` | Open page |
| `WebSearch` | Search web, or the specific web action |
| `AskUserQuestion`, `request_user_input`, `request_user_input_async` | Ask question |
| `Skill` | Use skill |
| MCP calls | Server name, with the action in the summary |

The source of desktop labels and styles is `shared/session/toolSummary.ts`. Native presentation lives in `ios/CogpitKit/Sources/CogpitKit/Models/ToolCallPresentation.swift`. Keep the meaning aligned when adding tools; preserve original tool names in source details.

Codex `exec` scripts are scanned for literal nested calls without executing JavaScript. Dynamic arguments stay available in source details. Shell argument arrays must preserve argument boundaries when displayed or copied.

Native iOS follows the same operation and section meanings with SwiftUI controls; see [its UI spec](../ios/UI_SPEC.md) and [parity ledger](../ios/PARITY_STATUS.md). Native question history remains an expanded, answerable card when a live question is pending.

## Transcript records

Token usage and other internal bookkeeping records do not belong in the conversation. Preserve them as metadata where needed. Structured tool outputs retain text, image blocks, and explicit error/exit status. Encrypted agent payloads display as "Encrypted message" with the available recipient, never as ciphertext in the summary or primary message body.

## Verification

Run `bun run test`, `bun run typecheck`, and the separate `packages/cogpit-memory` test suite. The latter has a documented Bun SQLite teardown crash; read affected file results individually. Browser QA must include parallel pending calls, explicit group collapse, per-call expansion, section expansion state, keyboard operation, light/dark mode, and phone-width overflow. When changing native presentation, check models with `swift run --package-path ios/CogpitKit cogpit-checks` and run the native tool-call UI tests in an iOS simulator. Verify collapsed and expanded calls, failed edits, empty output, large output, scripts, plan steps, images, and long paths on a phone-width layout.

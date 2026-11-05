# Tool call rendering

The web timeline shares tool-call components across desktop, Electron, and mobile browsers. Agent-specific parsing happens before presentation; normalized calls use the same operation names and disclosure structure. Native iOS uses the same operation meanings with its own SwiftUI controls.

## Shared web structure

- Each call is one line: an operation icon, a verb in the tense of its state ("Read", "Ran", "Edited"; "Reading", "Running" while it runs), then its target or description, and for edits the lines added and removed. The line truncates; the complete command or input remains available below. The tool's own name and the wall clock are in the row's tooltip.
- A running call swaps its icon for a spinner. Completed calls draw no status. Failed, awaiting-review and missing-result calls say so in words. Status is included in the disclosure’s accessible description. Hook timing and replaced-output metadata remain visible.
- An activity group is one line that says what the work did ("Ran 3 commands, read 2 files, thought for 4s"). It exposes running, failure, awaiting-review, and missing-result counts while collapsed. Opened, its calls hang off a rail as their own rows. Consecutive shell calls remain separate chronological rows, each with its own disclosure.
- Automatically opened live groups keep the latest three individual entries plus all pending, failed, and awaiting-review calls. Earlier entries can be revealed together. Explicit collapse wins over automatic opening; navigation to a call reveals its group. Thinking and question history retain their place.
- Opening a call shows its useful input and result. Ordinary commands show complete wrapping command text and an output preview immediately. Sectioned shell scripts keep one output disclosure per section with output. Global expansion preserves the user’s prior section choices.
- A detected failure inside a sectioned shell script appears in the row status and group count, even when a later shell command succeeded. Arbitrary tool text is not classified as a shell failure.
- File changes, plans, questions, and agent messages retain structured details.
- Calls with structured details keep original input and script source behind an explicit “Raw input” disclosure. Unknown calls and scripts without recoverable nested operations fall back to formatted input or source. Expanding all payloads does not expand the separate raw-input disclosure.
- Long output has a bounded preview and a control to reveal the complete value. Empty completed output is distinct from a call that is still running.
- An edit failure must show its error even when the proposed diff is available.
- A successful `Edit` or `Write` result marked `staged` shows "Awaiting review" with its proposed input and result text. It stays out of applied file summaries and undo.
- Structured `Bash` file diffs appear alongside command output, preserving hunk coordinates and any count of omitted file diffs. Reported diffs feed file summaries; omitted diffs cannot contribute changes. Shell diffs do not add undo support for those commands.
- Images and videos referenced with markdown image syntax render inline: images open in the zoomable viewer, and `mp4`, `m4v`, `webm` and `mov` files play with controls and seek over HTTP byte ranges. Only absolute local paths render, served by the Cogpit proxy; the CSP blocks remote `https://` media. On the web, persisted result images take precedence over a local-file preview for image reads.
- Phone layouts keep summaries within the available width and use touch-sized controls. Long file paths must not squeeze short operation names out of the header.

## Sub-sessions

A `cogpit-session new` call is shown as the sessions it started, not as a tool: one row per session, with the provider's mark, a dot for its state, its name, one line of what it was asked, its state and the time. The row unfolds to the brief, with the raw command a further click away, and its open button opens the session. Name, provider and live state (working, needs you) come from the session list, falling back to the name and `--agent` the start used. Starts stay visible when a finished turn folds its work.

A prompt that wakes a session because one it started finished or needs attention is shown as that session reporting back: the same row, with the reply's first line as its preview and the full reply inside.

Sub-agents (`Task`, `Agent`, `spawn_agent`) run inside the session on its own provider, so they stay ordinary tool rows with their activity panel. A pending `Task` or `Agent` call streams its agent's live output under its own row, and the panel streams only agents whose call has already returned. The panel says when an agent failed, was interrupted or was cancelled, rather than leaving it working.

## Messages

What the reader typed sits on the right as a bubble, with its time, Restore and branches under it on hover. Prompts nobody typed (background-task reports, crew chat deliveries, teammate messages, interrupts) run full width as events, and a prompt holding only context injected for the agent is not shown. Text the agent writes between steps carries copy and quote on hover only. The turn's last reply ends with the model, effort and time, and its copy and quote actions.

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

Run `bun run test`, `bun run typecheck`, and the separate `packages/cogpit-memory` test suite. The latter has a documented Bun SQLite teardown crash; read affected file results individually. Browser QA must include parallel pending calls, explicit group collapse, per-call expansion, section expansion state, keyboard operation, light/dark mode, and phone-width overflow. When changing native presentation, check models with `swift run --package-path ios/CogpitKit cogpit-checks` and run the native tool-call UI tests in an iOS simulator. Verify collapsed and expanded calls, failed and staged edits, structured shell diffs and omission notices, empty output, large output, scripts, plan steps, images, and long paths on a phone-width layout.

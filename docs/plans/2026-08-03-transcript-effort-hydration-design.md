# Transcript-derived effort on session open

**Date:** 2026-08-03
**Status:** Designed

## Problem

Opening the same session from the desktop app and the iOS app could show — and
then *persist* — different reasoning efforts.

Cogpit already syncs composer state across clients: `session-config/<key>.json`
is read and written by both the web client (`src/hooks/useSessionConfigSync.ts`)
and iOS (`ios/CogpitKit/.../Stores/ComposerSettings.swift`). That mechanism works.
The failure is in the **seed value** when nothing is stored:

- Web (`src/lib/utils.ts`): `DEFAULT_EFFORT = "high"`, and it leaves `effort: ""`.
- iOS (`ModelRules.swift`): `defaultEffort = "xhigh"`, and `ComposerSettings.swift`
  actively migrates a stored empty effort to `xhigh` **and writes it back**.

So opening a session on iOS rewrote the shared record and the desktop inherited
`xhigh`. Not drift — one client stomping the other.

Meanwhile both CLIs record the real effort in their transcripts and nothing read
it. `shared/session/codex.ts` already destructures `turn_context.payload.model`;
`payload.effort` sits beside it, ignored.

## Decision

The transcript is the source of truth for a session's effort, and it **wins on
open**. This replaces two divergent client-side guesses with one fact both
clients receive identically from the server.

Where effort lives in each transcript:

| Provider | Record | Field |
|---|---|---|
| Claude | `type: "assistant"` | `.effort` (top level) |
| Codex  | `type: "turn_context"` | `payload.effort`, or `payload.thread_settings.reasoning_effort` on newer CLIs |

## Design

### 1. Extraction — `server/sessionMetadata.ts`

`readTranscriptEffort(filePath): Promise<string | null>` scans **newest → oldest**
and returns the first hit. Last-wins is required: effort changes mid-session
(real sessions show e.g. `142 high / 51 xhigh`), so only the final record
reflects current state.

Three deliberate constraints:

- **Takes a file path, not a session id.** `findJsonlPath` lives in
  `sessionPaths.ts`, which already imports `sessionMetadata.ts` — resolving the
  path inside the extractor would create an import cycle. The route composes the
  two instead.
- **Separate from `getSessionMeta`.** That runs for every row of every session
  listing and would pay a tail scan for a value listings never use.
- **Reuses the existing backward chunked read** (4 KB × 128 = 512 KB cap) for
  files over 64 KB, matching `getSessionMeta`'s established pattern.

### 2. Overlay — `server/routes/session-config.ts`

`GET /api/session-config/:key` overlays the transcript effort onto the stored
object before responding. Server-side placement means **both clients get correct
behavior with no client logic** — writing this twice, in TypeScript and again in
Swift, is precisely how the current divergence happened.

Two guards:

- **`key.endsWith(".jsonl")`** — the key is *either* a session fileName *or* a
  project `dirName` (project-level MCP fallback). Project keys must not trigger a
  filesystem hunt.
- **`stored.ultracode !== true`** — the transcript records `effectiveEffort`, not
  `selectedEffort`. Under ultracode those differ: `useComposerSettings.ts` forces
  `xhigh`. Overlaying it onto a session whose underlying preference was `medium`
  would silently rewrite that preference, stranding the user at `xhigh` when they
  later toggle ultracode off.

GET stays read-only. `useSessionConfigSync` only seeds-and-writes when the
response is `{}`, so a non-empty overlay is applied without being persisted — the
derived value is not laundered into the store.

### 3. Remove the iOS migration

`ComposerSettings.swift` rewriting empty effort → `xhigh` is the stomping
mechanism. With the server authoritative it must go, or it will keep overwriting
what the server returns.

`ios/` is a separate private repository; that is a distinct commit.

## Accepted trade-offs

- **Pending choices lose to the transcript.** Set an effort → switch sessions →
  switch back without sending, and the transcript's older value wins. Hydration
  runs once per session open (`useSessionConfigSync.ts`), so mid-session edits are
  safe; only the switch-away-and-back path is exposed. Accepted rather than adding
  timestamp comparison.
- **Untranscripted sessions still use client defaults.** A session with no
  assistant turn yet has no transcript effort, so web (`high`) and iOS (`xhigh`)
  still differ at that moment. Unifying those constants is deliberately out of
  scope here.

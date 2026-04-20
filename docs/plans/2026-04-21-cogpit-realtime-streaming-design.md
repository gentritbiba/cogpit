# Cogpit Real-Time Response Streaming — Design

**Date:** 2026-04-21
**Status:** Approved, ready for implementation
**Author:** Design refined via brainstorming session

## Problem

Cogpit currently renders assistant messages wholesale when each JSONL line lands — there is no character-by-character streaming. Users see responses appear in large chunks after brief pauses, not the smooth token-by-token reveal Claude Desktop provides.

The Claude Agent SDK already supports token-level streaming via the `includePartialMessages` option, which emits `SDKPartialAssistantMessage` events (`type: 'stream_event'`) wrapping the raw Anthropic `BetaRawMessageStreamEvent`s (`content_block_delta` etc.). Cogpit currently does not opt in.

## Goal

Real-time character-by-character streaming of assistant responses in Cogpit that matches Claude Desktop's UX, without bloating session JSONL files or breaking history/search/export.

## Non-goals (v1)

- Streaming tool_use rendering (wait for complete input)
- Streaming subagent content
- Streaming thinking-block UI polish beyond what works today
- Cancel-mid-stream UX changes

## Key decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Transport for stream events | **Same SSE channel as lines, new event type `stream_event`**. Not persisted to JSONL. |
| 2 | SDK → SSE bridge | **Per-session `EventEmitter` on `SDKSessionState`**. SSE route subscribes on connect, unsubscribes on disconnect. |
| 3 | Delta reconciliation | **Index partials by `message.id`, swap on completion**. Partial held in an internal `Map<messageId, PartialAssistantMessage>` merged at render time. |
| 4 | Render coalescing | **`requestAnimationFrame` batching on the main thread**. No round-trip to the parser worker for stream events. |

## Architecture

```
┌──────────────────────┐
│  Anthropic API       │  content_block_delta (token-level)
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Claude CLI          │  (spawned by SDK, --stream-json internally)
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐     (still writes complete messages to JSONL)
│  Claude Agent SDK    │─────► session.jsonl ──┐
│  includePartialMsgs  │                       │
└──────────┬───────────┘                       │
           │ stream_event (ephemeral)          │
           ▼                                   ▼
┌──────────────────────┐              ┌──────────────────┐
│ sdk-session.ts       │              │ file-watch:      │
│ state.streamEmitter  │              │ tail JSONL       │
└──────────┬───────────┘              └────────┬─────────┘
           │                                   │
           └───────────┬───────────────────────┘
                       ▼
           ┌──────────────────────┐
           │  SSE /api/watch/...  │  (multiplexed: lines + stream_event)
           └──────────┬───────────┘
                      ▼
           ┌──────────────────────┐
           │ useLiveSession hook  │
           │ + rAF coalescer      │
           └──────────┬───────────┘
                      ▼
           ┌──────────────────────┐
           │ ParsedSession store  │  (partial blocks by messageId+index)
           └──────────┬───────────┘
                      ▼
           ┌──────────────────────┐
           │ AssistantText / UI   │  (updates at 60 Hz)
           └──────────────────────┘
```

## Invariants

- JSONL remains the **only persistent source of truth**. Stream events are ephemeral — lost on reconnect, and that's fine (the complete message will arrive via JSONL).
- `message.id` is the reconciliation key. The partial blob for a message is **discarded** the moment the corresponding complete assistant message arrives in JSONL.
- Partials never appear in session history, search, export, or token-count tooling.
- No new SSE endpoint — multiplexed over the existing `/api/watch/:dirName/:fileName`.

## Component-level changes

### Backend (`server/`)

**`sdk-session.ts`**
- Extend `SDKSessionState` with `streamEmitter: EventEmitter` (created in `initSDKSessionState`, cleaned up on session teardown).
- In `buildQueryOptions`, add `includePartialMessages: true`.
- In `processSDKEvent`, handle `msg.type === 'stream_event'`: emit `{event, parent_tool_use_id, ttft_ms}` on `state.streamEmitter`. Do **not** write to JSONL.

**`routes/files-watch.ts`**
- On SSE connect, after resolving `jsonlPath`, find the `SDKSessionState` by scanning `sdkSessions.values()` for a matching `jsonlPath`.
- If found, subscribe to `state.streamEmitter` and forward each event as SSE `{type: "stream_event", event, parent_tool_use_id, ttft_ms}`.
- On SSE disconnect, unsubscribe.
- No new throttle for stream events (they're already paced by the API).
- Existing `lines` 150 ms throttle untouched.

### Frontend (`src/`)

**`hooks/useLiveSession.ts`**
- Handle the new SSE event type. Push deltas into a `streamBuffer` (main thread, not worker).
- Add a `requestAnimationFrame` coalescer: on every event, schedule an `rAF` callback (if not already pending) that flushes `streamBuffer` into the parsed-session store.
- On SSE reconnect, drop all partials — the canonical JSONL catch-up handles correctness.

**Parser (worker or main-thread reducer)**
- Add a reducer for stream events:
  - `message_start` → create partial assistant message keyed by `message.id`
  - `content_block_start` → create partial block at `index`
  - `content_block_delta.text_delta` → append text to block[index]
  - `content_block_delta.input_json_delta` → append to tool_use JSON
  - `content_block_delta.thinking_delta` → append to thinking block
  - `message_stop` → mark partial as "ready for reconcile"
- When a complete assistant message arrives via JSONL with matching `message.id`: drop the partial, render the canonical.

**`components/timeline/AssistantText.tsx`**
- Render partial content blocks identically to complete ones. React key = `message.id + ':' + block.index`. Content just happens to grow over time.

### Type changes
- Add `StreamEventSSE` type to shared types used by both backend and frontend.
- No changes to `ParsedSession` public shape — partials live in an internal `partialMessages: Map<string, PartialAssistantMessage>` merged at render time.

## Edge cases

| Case | Handling |
|------|----------|
| Stream event arrives after the complete assistant message | Ignore — partial for that `message.id` already discarded. Debug-log. |
| Complete assistant message with no prior stream events | Normal path today. Renders fine. |
| SSE reconnect mid-stream | Partials for in-flight messages are lost; client resets them on reconnect. The canonical JSONL message fills the gap when the turn finishes. User sees a brief stall then the full message. Acceptable. |
| Multiple SSE clients on the same session | Each subscribes independently to `state.streamEmitter`. `EventEmitter` broadcasts natively. |
| Tool-use `input_json_delta` | Accumulates into the tool_use block's input. UI still waits for complete input to render tool call (v1 scope). |
| Thinking deltas | Same reconciliation path — content block type `thinking` with `thinking_delta`. |
| Subagent streams | Out of scope for v1. Subagents continue to flow through `subagentWatcher` JSONL synthesis. |
| Very long responses (8k+ tokens) | rAF coalescer caps updates at 60 Hz regardless of delta rate. |
| User navigates away mid-stream | `useLiveSession` cleanup closes SSE; server drops subscriber. Partials GC with hook state. |

## Testing

**New tests**
- `sdk-session.test.ts` — `includePartialMessages: true` is set; `stream_event` messages emit on `streamEmitter` and are NOT written to JSONL.
- `files-watch.test.ts` — SSE test: a fake stream event through the emitter appears in the SSE stream as `{type: "stream_event", ...}`. Disconnect unsubscribes.
- Parser tests — given `message_start` → deltas → `content_block_stop`, assert partial state shape. Given a subsequent canonical `assistant` message with matching id, assert partial is discarded.
- `useLiveSession.test.ts` — mock EventSource with interleaved `lines` + `stream_event`, assert rAF flush is called, assert final parsed-session matches JSONL after reconcile.

**Existing tests**
- `useLiveSession.test.ts` — batched-delivery expectations still pass; add new cases.
- Parser tests — no changes expected (partials live in separate internal map).

## Rollout

1. Ship behind feature flag `COGPIT_STREAM_PARTIAL=1` (default on in dev, off in prod).
2. Dogfood for a few days. Watch for CPU spikes, JSONL corruption, reconnect correctness.
3. Flip default to on. Keep kill switch ~2 weeks.
4. Remove flag once stable.

## Effort estimate

- Backend + SSE plumbing: ~1–2 hours
- Worker/parser delta reconciliation: ~2–3 hours
- UI + tests: ~1–2 hours
- **Total: ~half a day to a full day**, plus post-ship tuning.

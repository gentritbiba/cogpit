# Cogpit Real-Time Streaming — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stream assistant responses character-by-character in Cogpit, matching Claude Desktop's UX, without bloating JSONL files or breaking history/search/export.

**Architecture:** Opt the Claude Agent SDK into `includePartialMessages: true` to receive `stream_event` records. Bridge them from the SDK session into the existing SSE channel via a per-session `EventEmitter`. Frontend holds partials in main-thread state (keyed by `message.id`), merges them into the rendered view via the existing `requestAnimationFrame` coalescer, and discards partials when the canonical assistant message arrives via JSONL tail.

**Tech Stack:** TypeScript, Node built-in `events.EventEmitter`, Server-Sent Events (native `Response` streaming), React + Vite, Vitest (worker + hooks + server tests).

**Design doc:** `docs/plans/2026-04-21-cogpit-realtime-streaming-design.md`

**Feature flag:** `COGPIT_STREAM_PARTIAL` env var, default **on**; set to `0` to disable and restore current wholesale-message behavior.

---

## Phase 1 — Backend plumbing

Goal: SDK opts into partial messages, exposes them via per-session EventEmitter, and the SSE route forwards them.

### Task 1: Add `streamEmitter` to `SDKSessionState`

**Files:**
- Modify: `server/sdk-session.ts` (around lines 59-82 for interface, 311-332 for `initSDKSessionState`)

**Step 1: Write the failing test**

Create `server/__tests__/sdk-session-stream.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { EventEmitter } from "node:events"
// NOTE: initSDKSessionState is not exported today — Task 1 will export it.
import { initSDKSessionState } from "../sdk-session"

describe("SDKSessionState streaming", () => {
  it("initSDKSessionState sets up a streamEmitter", () => {
    const state = initSDKSessionState({
      sessionId: "test-session",
      cwd: "/tmp",
      message: "hi",
    })
    expect(state.streamEmitter).toBeInstanceOf(EventEmitter)
  })

  it("streamEmitter starts with no listeners", () => {
    const state = initSDKSessionState({
      sessionId: "test-session-2",
      cwd: "/tmp",
      message: "hi",
    })
    expect(state.streamEmitter.listenerCount("stream_event")).toBe(0)
  })
})
```

**Step 2: Run test to verify it fails**

```bash
bun run test server/__tests__/sdk-session-stream.test.ts
```
Expected: FAIL — `initSDKSessionState` not exported, or `streamEmitter` undefined.

**Step 3: Implement**

In `server/sdk-session.ts`:
1. Add `import { EventEmitter } from "node:events"` at the top.
2. In `SDKSessionState` interface, add:
   ```ts
   /** Per-session emitter for ephemeral stream_event messages. Broadcasts
    *  {event, parent_tool_use_id, ttft_ms} to SSE subscribers. */
   streamEmitter: EventEmitter
   ```
3. Export `initSDKSessionState` (change `function` → `export function`).
4. In `initSDKSessionState` return object, add:
   ```ts
   streamEmitter: new EventEmitter(),
   ```
5. Remove any `MaxListenersExceededWarning` risk by calling `emitter.setMaxListeners(0)` right after creation (two SSE clients + potential diagnostics).

**Step 4: Run test to verify it passes**

```bash
bun run test server/__tests__/sdk-session-stream.test.ts
```
Expected: PASS — both tests green.

**Step 5: Commit**

```bash
git add server/sdk-session.ts server/__tests__/sdk-session-stream.test.ts
git commit -m "feat(stream): add per-session EventEmitter for stream events"
```

---

### Task 2: Opt into `includePartialMessages` via feature flag

**Files:**
- Modify: `server/sdk-session.ts` (function `buildQueryOptions`, lines 136-182)

**Step 1: Write the failing test**

Append to `server/__tests__/sdk-session-stream.test.ts`:

```ts
describe("buildQueryOptions with partial messages", () => {
  const origEnv = process.env.COGPIT_STREAM_PARTIAL

  afterEach(() => {
    if (origEnv === undefined) delete process.env.COGPIT_STREAM_PARTIAL
    else process.env.COGPIT_STREAM_PARTIAL = origEnv
  })

  it("includePartialMessages is true by default", async () => {
    delete process.env.COGPIT_STREAM_PARTIAL
    const { buildQueryOptionsForTest } = await import("../sdk-session")
    const state = initSDKSessionState({ sessionId: "s1", cwd: "/tmp", message: "hi" })
    const opts = buildQueryOptionsForTest(state, {})
    expect(opts.includePartialMessages).toBe(true)
  })

  it("includePartialMessages is false when COGPIT_STREAM_PARTIAL=0", async () => {
    process.env.COGPIT_STREAM_PARTIAL = "0"
    const { buildQueryOptionsForTest } = await import("../sdk-session")
    const state = initSDKSessionState({ sessionId: "s2", cwd: "/tmp", message: "hi" })
    const opts = buildQueryOptionsForTest(state, {})
    expect(opts.includePartialMessages).toBe(false)
  })
})
```

Add `import { afterEach } from "vitest"` at the top of the file.

**Step 2: Run test to verify it fails**

```bash
bun run test server/__tests__/sdk-session-stream.test.ts
```
Expected: FAIL — `buildQueryOptionsForTest` not exported.

**Step 3: Implement**

In `server/sdk-session.ts`:
1. Export an internal test alias after `buildQueryOptions`:
   ```ts
   /** @internal test-only alias */
   export const buildQueryOptionsForTest = buildQueryOptions
   ```
2. Inside `buildQueryOptions`, after the existing `queryOpts` object is assembled, add:
   ```ts
   const streamPartial = process.env.COGPIT_STREAM_PARTIAL !== "0"
   queryOpts.includePartialMessages = streamPartial
   ```

**Step 4: Run test to verify it passes**

```bash
bun run test server/__tests__/sdk-session-stream.test.ts
```
Expected: PASS.

**Step 5: Commit**

```bash
git add server/sdk-session.ts server/__tests__/sdk-session-stream.test.ts
git commit -m "feat(stream): opt into includePartialMessages (opt-out via COGPIT_STREAM_PARTIAL=0)"
```

---

### Task 3: Handle `stream_event` in `processSDKEvent`

**Files:**
- Modify: `server/sdk-session.ts` (`processSDKEvent`, lines 186-204)

**Step 1: Write the failing test**

Append to `server/__tests__/sdk-session-stream.test.ts`:

```ts
describe("processSDKEvent — stream_event handling", () => {
  it("emits stream_event payloads on state.streamEmitter", async () => {
    const { processSDKEventForTest } = await import("../sdk-session")
    const state = initSDKSessionState({ sessionId: "s3", cwd: "/tmp", message: "hi" })

    const received: Array<{ event: unknown; parent_tool_use_id: string | null; ttft_ms?: number }> = []
    state.streamEmitter.on("stream_event", (payload) => received.push(payload))

    processSDKEventForTest(state, {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      parent_tool_use_id: null,
      uuid: "u1",
      session_id: "s3",
      ttft_ms: 321,
    } as unknown as Parameters<typeof processSDKEventForTest>[1])

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      event: { type: "content_block_delta" },
      parent_tool_use_id: null,
      ttft_ms: 321,
    })
  })

  it("ignores non-stream_event messages (does not emit)", async () => {
    const { processSDKEventForTest } = await import("../sdk-session")
    const state = initSDKSessionState({ sessionId: "s4", cwd: "/tmp", message: "hi" })

    const received: unknown[] = []
    state.streamEmitter.on("stream_event", (p) => received.push(p))

    processSDKEventForTest(state, { type: "assistant", message: { content: [] } } as unknown as Parameters<typeof processSDKEventForTest>[1])

    expect(received).toHaveLength(0)
  })
})
```

**Step 2: Run test to verify it fails**

```bash
bun run test server/__tests__/sdk-session-stream.test.ts
```
Expected: FAIL — `processSDKEventForTest` not exported.

**Step 3: Implement**

In `server/sdk-session.ts`:
1. Inside `processSDKEvent`, at the top (before the `result` branch), add:
   ```ts
   if (msg.type === "stream_event") {
     const partial = msg as unknown as {
       event: unknown
       parent_tool_use_id: string | null
       ttft_ms?: number
     }
     state.streamEmitter.emit("stream_event", {
       event: partial.event,
       parent_tool_use_id: partial.parent_tool_use_id,
       ttft_ms: partial.ttft_ms,
     })
     return // do not persist, do not fall through
   }
   ```
2. Export a test alias:
   ```ts
   /** @internal test-only alias */
   export const processSDKEventForTest = processSDKEvent
   ```

**Step 4: Run test to verify it passes**

```bash
bun run test server/__tests__/sdk-session-stream.test.ts
```
Expected: PASS — all tests green.

**Step 5: Also confirm no regression in existing tests**

```bash
bun run test
```
Expected: 1384+ tests passing.

**Step 6: Commit**

```bash
git add server/sdk-session.ts server/__tests__/sdk-session-stream.test.ts
git commit -m "feat(stream): emit stream_event from processSDKEvent"
```

---

### Task 4: Forward stream events through SSE in `files-watch.ts`

**Files:**
- Modify: `server/routes/files-watch.ts` (the `/api/watch/` handler, lines 108-304)
- Modify: `server/sdk-session.ts` (add reverse-lookup helper)

**Context:** The SSE route needs to find the `SDKSessionState` whose `jsonlPath` matches the file it's tailing. `sdkSessions` is keyed by `sessionId`, so we scan its values.

**Step 1: Write the failing test**

Create `server/__tests__/files-watch-stream.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest"
import { initSDKSessionState, sdkSessions, findSessionByJsonlPath } from "../sdk-session"

describe("findSessionByJsonlPath", () => {
  afterEach(() => sdkSessions.clear())

  it("returns the session whose jsonlPath matches", () => {
    const state = initSDKSessionState({ sessionId: "sid-1", cwd: "/tmp", message: "hi" })
    state.jsonlPath = "/tmp/sessions/abc.jsonl"
    sdkSessions.set("sid-1", state)

    const found = findSessionByJsonlPath("/tmp/sessions/abc.jsonl")
    expect(found).toBe(state)
  })

  it("returns null when no session matches", () => {
    expect(findSessionByJsonlPath("/tmp/nope.jsonl")).toBeNull()
  })
})
```

**Step 2: Run test to verify it fails**

```bash
bun run test server/__tests__/files-watch-stream.test.ts
```
Expected: FAIL — `findSessionByJsonlPath` not exported.

**Step 3: Implement the helper**

In `server/sdk-session.ts`, add at the bottom of the file:

```ts
/** Find the SDK session currently writing to a given JSONL path, or null. */
export function findSessionByJsonlPath(jsonlPath: string): SDKSessionState | null {
  for (const state of sdkSessions.values()) {
    if (state.jsonlPath === jsonlPath) return state
  }
  return null
}
```

**Step 4: Run helper test to verify it passes**

```bash
bun run test server/__tests__/files-watch-stream.test.ts
```
Expected: PASS.

**Step 5: Wire the SSE route to the emitter**

In `server/routes/files-watch.ts`:

1. Add at the top: `import { findSessionByJsonlPath } from "../sdk-session"`
2. Inside the `/api/watch/` handler, after the line `res.write(\`data: ${JSON.stringify({ type: "init", offset, recentlyActive })}\n\n\`)` inside the `.then` block, subscribe to the session's emitter:
   ```ts
   // ── Stream events: forward SDK partial messages via SSE ──────────
   const streamSession = findSessionByJsonlPath(filePath)
   const onStreamEvent = streamSession
     ? (payload: { event: unknown; parent_tool_use_id: string | null; ttft_ms?: number }) => {
         if (closed) return
         res.write(`data: ${JSON.stringify({ type: "stream_event", ...payload })}\n\n`)
       }
     : null
   if (streamSession && onStreamEvent) {
     streamSession.streamEmitter.on("stream_event", onStreamEvent)
   }
   ```
3. In the `cleanup()` function, add:
   ```ts
   if (streamSession && onStreamEvent) {
     streamSession.streamEmitter.off("stream_event", onStreamEvent)
   }
   ```
   Note: `streamSession` and `onStreamEvent` must be declared in the outer scope accessible to `cleanup` — hoist them above `function cleanup()` with `let` declarations, then assign inside the `.then`.

**Step 6: Add integration test for SSE forwarding**

Append to `server/__tests__/files-watch-stream.test.ts`:

```ts
import { EventEmitter } from "node:events"

describe("SSE stream event forwarding", () => {
  afterEach(() => sdkSessions.clear())

  it("forwards stream_event payloads to res.write as SSE data", async () => {
    // Use a stub SDK state with a real EventEmitter
    const state = initSDKSessionState({ sessionId: "sse-1", cwd: "/tmp", message: "hi" })
    state.jsonlPath = "/tmp/test-sse-session.jsonl"
    sdkSessions.set("sse-1", state)

    // Collect what would be written to SSE
    const writes: string[] = []
    const fakeRes = {
      write: (chunk: string) => writes.push(chunk),
    }

    // Simulate what files-watch.ts will do:
    const onStreamEvent = (payload: unknown) => {
      fakeRes.write(`data: ${JSON.stringify({ type: "stream_event", ...(payload as object) })}\n\n`)
    }
    state.streamEmitter.on("stream_event", onStreamEvent)

    state.streamEmitter.emit("stream_event", {
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "abc" } },
      parent_tool_use_id: null,
      ttft_ms: 100,
    })

    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('"type":"stream_event"')
    expect(writes[0]).toContain('"text":"abc"')
  })
})
```

**Step 7: Run tests to verify they pass**

```bash
bun run test server/__tests__/files-watch-stream.test.ts
bun run test
```
Expected: all pass.

**Step 8: Commit**

```bash
git add server/sdk-session.ts server/routes/files-watch.ts server/__tests__/files-watch-stream.test.ts
git commit -m "feat(stream): forward stream events through SSE watch channel"
```

---

## Phase 2 — Shared types

### Task 5: Add `StreamEventSSE` and `PartialAssistantMessage` types

**Files:**
- Modify: `src/lib/types.ts`

**Step 1: Write the failing test**

Create `src/lib/__tests__/streaming-types.test.ts`:

```ts
import { describe, it, expectTypeOf } from "vitest"
import type { StreamEventSSE, PartialAssistantMessage, PartialContentBlock } from "@/lib/types"

describe("streaming types", () => {
  it("StreamEventSSE has required fields", () => {
    const sample: StreamEventSSE = {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
      parent_tool_use_id: null,
    }
    expectTypeOf(sample).toHaveProperty("type")
    expectTypeOf(sample).toHaveProperty("event")
  })

  it("PartialAssistantMessage groups blocks by index", () => {
    const sample: PartialAssistantMessage = {
      messageId: "msg_123",
      blocks: new Map<number, PartialContentBlock>([
        [0, { type: "text", text: "hello" }],
      ]),
      stopped: false,
    }
    expectTypeOf(sample.blocks).toMatchTypeOf<Map<number, PartialContentBlock>>()
  })
})
```

**Step 2: Run test to verify it fails**

```bash
bun run test src/lib/__tests__/streaming-types.test.ts
```
Expected: FAIL — types not exported.

**Step 3: Implement**

Append to `src/lib/types.ts`:

```ts
// ── Live streaming (partial messages) ───────────────────────────────────────
// These types model the real-time token-by-token stream delivered via SSE.
// Partials live only in-memory on the client; they are discarded as soon as
// the canonical assistant message arrives via the JSONL tail.

/** A single partial content block being accumulated from stream deltas. */
export type PartialContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; partialInputJson: string }

export interface PartialAssistantMessage {
  messageId: string
  /** Blocks keyed by Anthropic API content_block index. */
  blocks: Map<number, PartialContentBlock>
  /** Set to true once the API sends message_stop for this message. */
  stopped: boolean
}

/** Payload the SSE channel emits for each SDK partial message. */
export interface StreamEventSSE {
  type: "stream_event"
  /** Raw Anthropic BetaRawMessageStreamEvent — shape varies by event type. */
  event: {
    type:
      | "message_start"
      | "content_block_start"
      | "content_block_delta"
      | "content_block_stop"
      | "message_delta"
      | "message_stop"
    index?: number
    message?: { id: string }
    content_block?: { type: string; id?: string; name?: string }
    delta?: {
      type: "text_delta" | "input_json_delta" | "thinking_delta" | "signature_delta"
      text?: string
      partial_json?: string
      thinking?: string
    }
  }
  parent_tool_use_id: string | null
  ttft_ms?: number
}
```

**Step 4: Run test to verify it passes**

```bash
bun run test src/lib/__tests__/streaming-types.test.ts
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/__tests__/streaming-types.test.ts
git commit -m "feat(stream): add StreamEventSSE and PartialAssistantMessage types"
```

---

## Phase 3 — Frontend partial-message state

### Task 6: Pure reducer for partial assistant messages

**Context:** We keep partials in a pure reducer so it's trivial to test. The reducer takes the current `Map<messageId, PartialAssistantMessage>` and a `StreamEventSSE` and returns the next map.

**Files:**
- Create: `src/lib/partialMessages.ts`
- Create: `src/lib/__tests__/partialMessages.test.ts`

**Step 1: Write failing tests**

Create `src/lib/__tests__/partialMessages.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { applyStreamEvent, dropByMessageIds } from "@/lib/partialMessages"
import type { PartialAssistantMessage, StreamEventSSE } from "@/lib/types"

const evt = (event: StreamEventSSE["event"]): StreamEventSSE => ({
  type: "stream_event",
  event,
  parent_tool_use_id: null,
})

describe("applyStreamEvent", () => {
  it("message_start creates an empty partial", () => {
    const next = applyStreamEvent(new Map(), evt({ type: "message_start", message: { id: "msg_1" } }))
    expect(next.has("msg_1")).toBe(true)
    expect(next.get("msg_1")!.stopped).toBe(false)
    expect(next.get("msg_1")!.blocks.size).toBe(0)
  })

  it("content_block_start creates an empty text block at index", () => {
    let m = new Map<string, PartialAssistantMessage>()
    m = applyStreamEvent(m, evt({ type: "message_start", message: { id: "m1" } }))
    m = applyStreamEvent(m, evt({ type: "content_block_start", index: 0, content_block: { type: "text" } }))
    expect(m.get("m1")!.blocks.get(0)).toEqual({ type: "text", text: "" })
  })

  it("text_delta appends to the current block", () => {
    let m = new Map<string, PartialAssistantMessage>()
    m = applyStreamEvent(m, evt({ type: "message_start", message: { id: "m2" } }))
    m = applyStreamEvent(m, evt({ type: "content_block_start", index: 0, content_block: { type: "text" } }))
    m = applyStreamEvent(m, evt({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }))
    m = applyStreamEvent(m, evt({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }))
    expect(m.get("m2")!.blocks.get(0)).toEqual({ type: "text", text: "Hello" })
  })

  it("thinking_delta appends to thinking block", () => {
    let m = new Map<string, PartialAssistantMessage>()
    m = applyStreamEvent(m, evt({ type: "message_start", message: { id: "m3" } }))
    m = applyStreamEvent(m, evt({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }))
    m = applyStreamEvent(m, evt({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning..." } }))
    expect(m.get("m3")!.blocks.get(0)).toEqual({ type: "thinking", text: "reasoning..." })
  })

  it("input_json_delta appends to tool_use partial input", () => {
    let m = new Map<string, PartialAssistantMessage>()
    m = applyStreamEvent(m, evt({ type: "message_start", message: { id: "m4" } }))
    m = applyStreamEvent(m, evt({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Read" } }))
    m = applyStreamEvent(m, evt({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file"' } }))
    m = applyStreamEvent(m, evt({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ':"x"}' } }))
    expect(m.get("m4")!.blocks.get(0)).toEqual({ type: "tool_use", id: "t1", name: "Read", partialInputJson: '{"file":"x"}' })
  })

  it("message_stop marks the partial as stopped", () => {
    let m = new Map<string, PartialAssistantMessage>()
    m = applyStreamEvent(m, evt({ type: "message_start", message: { id: "m5" } }))
    m = applyStreamEvent(m, evt({ type: "message_stop" }))
    // message_stop carries no id; we mark ALL in-flight partials as stopped? No — we need to track the currently-open message.
    // Simpler contract: mark the most recently opened partial as stopped.
    expect(m.get("m5")!.stopped).toBe(true)
  })

  it("is a no-op for unknown event types", () => {
    const m = new Map<string, PartialAssistantMessage>()
    const next = applyStreamEvent(m, evt({ type: "message_delta" as StreamEventSSE["event"]["type"] }))
    expect(next).toBe(m)
  })
})

describe("dropByMessageIds", () => {
  it("removes the given ids from the map", () => {
    const m = new Map<string, PartialAssistantMessage>([
      ["a", { messageId: "a", blocks: new Map(), stopped: true }],
      ["b", { messageId: "b", blocks: new Map(), stopped: false }],
    ])
    const next = dropByMessageIds(m, new Set(["a"]))
    expect(next.has("a")).toBe(false)
    expect(next.has("b")).toBe(true)
  })

  it("returns the same reference when nothing is dropped", () => {
    const m = new Map<string, PartialAssistantMessage>([
      ["a", { messageId: "a", blocks: new Map(), stopped: true }],
    ])
    expect(dropByMessageIds(m, new Set(["nope"]))).toBe(m)
  })
})
```

**Step 2: Run test to verify it fails**

```bash
bun run test src/lib/__tests__/partialMessages.test.ts
```
Expected: FAIL — module not found.

**Step 3: Implement**

Create `src/lib/partialMessages.ts`:

```ts
import type { PartialAssistantMessage, PartialContentBlock, StreamEventSSE } from "@/lib/types"

/**
 * Pure reducer: apply one SSE stream event to the partial-messages map and
 * return the next map. Returns the SAME reference when nothing changes so
 * callers can skip re-renders cheaply.
 *
 * Event semantics:
 *   - message_start         → create empty partial, track as "current"
 *   - content_block_start   → seed an empty block at `index`
 *   - content_block_delta   → append text/thinking/json to block at `index`
 *   - content_block_stop    → no-op (block already sealed by future deltas)
 *   - message_stop          → mark the most recently started partial stopped
 *   - anything else         → no-op
 */
export function applyStreamEvent(
  map: Map<string, PartialAssistantMessage>,
  payload: StreamEventSSE,
): Map<string, PartialAssistantMessage> {
  const ev = payload.event

  if (ev.type === "message_start" && ev.message?.id) {
    const next = new Map(map)
    next.set(ev.message.id, {
      messageId: ev.message.id,
      blocks: new Map(),
      stopped: false,
    })
    return next
  }

  // For block-level events we target the most recently started partial.
  const currentId = mostRecentId(map)
  if (!currentId) return map
  const current = map.get(currentId)
  if (!current) return map

  if (ev.type === "content_block_start" && typeof ev.index === "number") {
    const block = seedBlock(ev.content_block)
    if (!block) return map
    const nextBlocks = new Map(current.blocks)
    nextBlocks.set(ev.index, block)
    return replaceCurrent(map, currentId, { ...current, blocks: nextBlocks })
  }

  if (ev.type === "content_block_delta" && typeof ev.index === "number" && ev.delta) {
    const block = current.blocks.get(ev.index)
    const updated = applyDelta(block, ev.delta)
    if (!updated || updated === block) return map
    const nextBlocks = new Map(current.blocks)
    nextBlocks.set(ev.index, updated)
    return replaceCurrent(map, currentId, { ...current, blocks: nextBlocks })
  }

  if (ev.type === "message_stop") {
    if (current.stopped) return map
    return replaceCurrent(map, currentId, { ...current, stopped: true })
  }

  return map
}

/**
 * Drop the given message ids from the map. Used to discard partials once the
 * canonical assistant message arrives via JSONL tail.
 */
export function dropByMessageIds(
  map: Map<string, PartialAssistantMessage>,
  ids: Set<string>,
): Map<string, PartialAssistantMessage> {
  let changed = false
  for (const id of ids) {
    if (map.has(id)) { changed = true; break }
  }
  if (!changed) return map
  const next = new Map(map)
  for (const id of ids) next.delete(id)
  return next
}

// ── Internals ────────────────────────────────────────────────────────────

function mostRecentId(map: Map<string, PartialAssistantMessage>): string | null {
  let last: string | null = null
  for (const id of map.keys()) last = id // Map preserves insertion order
  return last
}

function replaceCurrent(
  map: Map<string, PartialAssistantMessage>,
  id: string,
  next: PartialAssistantMessage,
): Map<string, PartialAssistantMessage> {
  const out = new Map(map)
  out.set(id, next)
  return out
}

function seedBlock(cb: StreamEventSSE["event"]["content_block"]): PartialContentBlock | null {
  if (!cb) return null
  if (cb.type === "text") return { type: "text", text: "" }
  if (cb.type === "thinking") return { type: "thinking", text: "" }
  if (cb.type === "tool_use" && cb.id && cb.name) {
    return { type: "tool_use", id: cb.id, name: cb.name, partialInputJson: "" }
  }
  return null
}

function applyDelta(
  block: PartialContentBlock | undefined,
  delta: NonNullable<StreamEventSSE["event"]["delta"]>,
): PartialContentBlock | null {
  if (!block) return null
  if (delta.type === "text_delta" && block.type === "text" && delta.text !== undefined) {
    return { ...block, text: block.text + delta.text }
  }
  if (delta.type === "thinking_delta" && block.type === "thinking" && delta.thinking !== undefined) {
    return { ...block, text: block.text + delta.thinking }
  }
  if (delta.type === "input_json_delta" && block.type === "tool_use" && delta.partial_json !== undefined) {
    return { ...block, partialInputJson: block.partialInputJson + delta.partial_json }
  }
  // signature_delta and others are ignored (no UI impact in v1)
  return block
}
```

**Step 4: Run test to verify it passes**

```bash
bun run test src/lib/__tests__/partialMessages.test.ts
```
Expected: PASS — all tests green.

**Step 5: Commit**

```bash
git add src/lib/partialMessages.ts src/lib/__tests__/partialMessages.test.ts
git commit -m "feat(stream): pure reducer for partial assistant messages"
```

---

### Task 7: Integrate partials into `useLiveSession`

**Files:**
- Modify: `src/hooks/useLiveSession.ts`
- Modify: `src/hooks/__tests__/useLiveSession.test.ts` (add cases, keep existing)

**Step 1: Write the failing test (append to existing suite)**

Add to `src/hooks/__tests__/useLiveSession.test.ts`:

```ts
describe("stream_event SSE handling", () => {
  it("exposes partialMessages that grow with stream_event deltas", async () => {
    // Test shape: mount useLiveSession, fire stream_event message_start + text_delta
    // through the mock EventSource, assert the hook's returned partialMessages
    // contains the new text.
    //
    // (Write this test referencing the existing mock EventSource helper in
    //  this file — see how the lines tests set up MockEventSource. Reuse it.)
    expect(true).toBe(true) // placeholder — fill in during impl step
  })

  it("discards partial for message.id when canonical assistant line arrives", async () => {
    expect(true).toBe(true) // placeholder — fill in during impl step
  })
})
```

**Note to executor:** The existing `useLiveSession.test.ts` already has a mock `EventSource`. Study it first, then flesh out the two tests above to actually drive events through that mock and assert on `partialMessages` from the hook's return. Replace the placeholder `expect(true).toBe(true)` lines with real assertions once you've seen the mock API.

**Step 2: Run test to verify it fails**

```bash
bun run test src/hooks/__tests__/useLiveSession.test.ts
```
Expected: placeholders pass, but once you flesh them out they should fail until Step 3.

**Step 3: Implement**

Modify `src/hooks/useLiveSession.ts`:

1. Add imports:
   ```ts
   import type { PartialAssistantMessage, StreamEventSSE } from "@/lib/types"
   import { applyStreamEvent, dropByMessageIds } from "@/lib/partialMessages"
   ```
2. Add a `const [partialMessages, setPartialMessages] = useState<Map<string, PartialAssistantMessage>>(new Map())` near the other state declarations.
3. Add a `partialsRef = useRef(partialMessages)` that mirrors it.
4. In the SSE effect, inside `es.onmessage`, add a branch:
   ```ts
   } else if (data.type === "stream_event") {
     const next = applyStreamEvent(partialsRef.current, data as StreamEventSSE)
     if (next !== partialsRef.current) {
       partialsRef.current = next
       pendingPartialsFlush = true
       scheduleUpdate()
     }
   }
   ```
   Rename existing `pendingUpdate` / `scheduleUpdate` / `flushUpdate` logic if needed so the rAF flush also publishes partial updates via `setPartialMessages`:
   ```ts
   let pendingPartialsFlush = false
   const flushUpdate = () => {
     pendingUpdate = false
     rafId = null
     if (pendingPartialsFlush) {
       pendingPartialsFlush = false
       setPartialMessages(partialsRef.current)
     }
     if (sessionRef.current) {
       onUpdateRef.current(sessionRef.current)
     }
   }
   ```
5. After the worker resolves (`.then((result) => {...}`), scan the new session's assistant message ids and drop any partials whose id now appears in the canonical session:
   ```ts
   const idsInSession = new Set<string>()
   for (const turn of result.turns) {
     for (const block of turn.content) {
       if (block.kind === "assistant") idsInSession.add(block.message.id)
     }
   }
   const trimmed = dropByMessageIds(partialsRef.current, idsInSession)
   if (trimmed !== partialsRef.current) {
     partialsRef.current = trimmed
     pendingPartialsFlush = true
   }
   ```
   (Adapt the shape above to match the actual `Turn`/`TurnContentBlock` shape — see `src/lib/types.ts:201-225`.)
6. On reconnect (`es.onerror`) reset partials:
   ```ts
   partialsRef.current = new Map()
   setPartialMessages(partialsRef.current)
   ```
7. Reset partials when the source changes (in the rawText effect): `partialsRef.current = new Map(); setPartialMessages(partialsRef.current)`
8. Return `partialMessages` from the hook:
   ```ts
   return { isLive, sseState, isCompacting, partialMessages }
   ```

**Step 4: Flesh out the placeholder tests from Step 1**

Drive `stream_event` messages through the mock EventSource and assert `partialMessages` contains the partial. Fire a canonical `lines` event with an `assistant` message whose id matches, wait one `rAF` tick (use a timer/fake-rAF helper or `await new Promise(r => setTimeout(r, 20))`), assert the partial was dropped.

**Step 5: Run test to verify it passes**

```bash
bun run test src/hooks/__tests__/useLiveSession.test.ts
```
Expected: all tests pass.

**Step 6: Verify no regression**

```bash
bun run test
```
Expected: 1384+ tests passing.

**Step 7: Commit**

```bash
git add src/hooks/useLiveSession.ts src/hooks/__tests__/useLiveSession.test.ts
git commit -m "feat(stream): integrate partial-message state into useLiveSession"
```

---

## Phase 4 — Rendering

### Task 8: Thread `partialMessages` through the timeline render path

**Files:**
- Modify: `src/App.tsx` (or wherever `useLiveSession` is consumed — search for `useLiveSession(`)
- Modify: `src/components/timeline/TurnSection.tsx` (accept optional `partial` prop)
- Modify: `src/components/timeline/AssistantText.tsx` (render partial text identically to complete text)

**Context:** Find the consumer first:

```bash
rg 'useLiveSession\(' src
```

That will show you where to grab `partialMessages` and forward it to whatever component renders `ParsedSession.turns`.

**Step 1: Write a rendering test**

Create `src/components/timeline/__tests__/AssistantText.partial.test.tsx`:

```tsx
import { describe, it, expect } from "vitest"
import { render } from "@testing-library/react"
import { AssistantText } from "@/components/timeline/AssistantText"

describe("AssistantText — partial rendering", () => {
  it("renders partial text identically to complete text", () => {
    // AssistantText accepts { text: string } currently. Verify it
    // renders whatever string it's given, regardless of whether that
    // string is partial or complete.
    const { getByText } = render(<AssistantText text="Hel" />)
    expect(getByText("Hel")).toBeInTheDocument()
  })
})
```

(If the existing `AssistantText` prop shape differs, read the file first and adapt.)

**Step 2: Run test to verify it passes on unchanged component**

```bash
bun run test src/components/timeline/__tests__/AssistantText.partial.test.tsx
```
Expected: PASS — no changes needed to `AssistantText` itself if it's already a dumb string renderer. If it fails, adapt the test to the actual API.

**Step 3: Wire partials into the turn renderer**

Find the component that maps `ParsedSession.turns` to React children. Adjacent to each assistant message render, check `partialMessages.get(message.id)`. If present AND the message is the "last" one (in-flight), render the partial's blocks *instead of* the complete content; if the complete message has content already, the canonical wins (partials are only useful before the canonical arrives — in practice this won't happen, but defensive).

Simpler approach: render partials as **synthetic turns appended to the end**:

1. In the timeline component, before rendering `session.turns`, compute `effectiveTurns = [...session.turns, ...synthesizePartialTurns(partialMessages)]` where `synthesizePartialTurns` converts each `PartialAssistantMessage` whose `messageId` is not already represented in `session.turns` into a synthetic Turn for rendering.
2. `synthesizePartialTurns` is a new helper in `src/lib/partialMessages.ts`:
   ```ts
   export function synthesizePartialTurns(
     partials: Map<string, PartialAssistantMessage>,
     existingAssistantIds: Set<string>,
   ): PartialRenderTurn[] { ... }
   ```
   Return a lightweight shape the existing `TurnSection` can render. If extending `TurnContentBlock` is too invasive, introduce a new `PartialAssistantTurn` that renders through a dedicated component path.
3. If the least invasive path is cleanest: add a new component `<PartialAssistantBlock partial={p} />` that renders below the last real turn. Reuse `AssistantText` for text blocks. Skip tool_use (v1 non-goal).

**Add tests** for `synthesizePartialTurns`:

```ts
describe("synthesizePartialTurns", () => {
  it("returns empty array when partials map is empty", () => { /* ... */ })
  it("skips partials whose messageId is already in existingAssistantIds", () => { /* ... */ })
  it("emits a renderable turn for new partial messageIds in insertion order", () => { /* ... */ })
})
```

**Step 4: Run tests**

```bash
bun run test
```
Expected: all pass.

**Step 5: Commit**

```bash
git add src/
git commit -m "feat(stream): render partial assistant messages in timeline"
```

---

## Phase 5 — Verification

### Task 9: End-to-end manual test via agent-browser

**Files:** none (manual verification task)

**Steps:**

1. Launch the dev server:
   ```bash
   cd /Users/gentritbiba/agent-window/.worktrees/streaming-responses
   bun run dev
   ```
2. Open the app in agent-browser (see `~/.claude/CLAUDE.md` rule about UI testing with agent-browser).
3. Create a new session. Send a message that forces a long response, e.g. "Write a 200-word essay on ant colonies."
4. Observe the response as it streams. It MUST arrive character-by-character (or small chunk by small chunk), not in a single whump after several seconds.
5. Wait for the response to finish; verify it is readable end-to-end (no duplication, no flicker).
6. **Regression check:** Ask another question. Verify tool calls still render correctly (Read/Write/Grep/etc.). Open the file at `~/.claude/agent-window/sessions/<sessionId>/session.jsonl` and confirm there are NO `stream_event` records in it (only the canonical `assistant` and `user` types).
7. **Opt-out check:** Kill the dev server. Start it with `COGPIT_STREAM_PARTIAL=0 bun run dev`. Send a message. Verify responses arrive in chunks as before (old behavior preserved).
8. **Close agent-browser** per `~/.claude/CLAUDE.md`.

### Task 10: Final full-test sweep

```bash
cd /Users/gentritbiba/agent-window/.worktrees/streaming-responses
bun run test
bun run build
```

Both must pass. If build fails due to a type error in a file you didn't touch, investigate — it may be a pre-existing issue, report back.

### Task 11: Commit any follow-ups discovered during manual testing

```bash
git status
git add <relevant-files>
git commit -m "fix(stream): <specific-issue>"
```

---

## Integration notes

**No new API route** — all changes multiplex over the existing `/api/watch/:dirName/:fileName` SSE. Per project CLAUDE.md, new routes must be registered in both `server/api-plugin.ts` and `electron/server.ts`; since we're not adding a route, neither file needs editing.

**Feature flag default: ON.** Users opt out with `COGPIT_STREAM_PARTIAL=0`. This matches the design doc's "flip default to on quickly" rollout.

**Subagent streaming is out of scope.** Subagent JSONL synthesis via `subagentWatcher.ts` remains unchanged. If we later want subagents to stream, we'll opt them in separately.

**Worker round-trips avoided.** Partial-message state lives on the main thread. The parser worker continues to own canonical `ParsedSession` construction. Stream events never cross the worker boundary.

**If any task surfaces a missing piece** (e.g. the actual `AssistantText` prop shape differs from what's assumed here), read the file, adapt the code, and keep the TDD discipline — don't skip the failing-test step just because the implementation is straightforward.

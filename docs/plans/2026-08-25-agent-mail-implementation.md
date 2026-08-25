# Agent Mail Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Render inbound peer-agent messages as identifiable mail with reply state, instead of generic "Queued while working" cards containing a raw XML envelope.

**Architecture:** Claude Code already persists `attachment.origin` with `kind: "human" | "peer"`, a pre-stripped `body`, the sender name, and a stable `senderTaskId`. `shared/session/types.ts` declares only four `attachment` fields and drops the rest, so `turnBuilder` never sees any of it. Widen the type, branch on `origin.kind` to emit a new `agent_message` block, pair each message with the `SendMessage` that answered it, and render it with a dedicated card. A regex parser covers older records that predate `origin`.

**Tech Stack:** TypeScript, React 19, Tailwind v4, Vitest + @testing-library/react, bun.

**Design doc:** `docs/plans/2026-08-25-agent-mail-design.md`

**Branch:** `agent-mail-rendering` (already created; the design doc is committed there).

---

## Orientation for the implementer

Things that are non-obvious about this codebase and will cost you an hour if you miss them:

1. **`shared/session/` is the canonical copy.** `packages/cogpit-memory/src/lib/` is a *generated mirror*. Never edit it by hand. After changing anything under `shared/session/`, run `bun run sync-cogpit-memory`. The `check:cogpit-memory-sync` script fails CI if you forget.
2. **`src/lib/types.ts` re-exports the shared types.** Import `TurnContentBlock` from `@/lib/types` in client code, from `./types` in shared code.
3. **The enqueue ledger keys on raw text.** `noteEnqueueSourced` / `consumeEnqueueSourced` reconcile a `queue-operation` enqueue against the later `attachment` copy of the *same* prompt by exact string match on the raw prompt text. If you start keying that ledger on the stripped body, every peer message renders twice. Keep `raw` as the ledger key throughout.
4. **Tests are Vitest, run with `bun run test`.** Per `CLAUDE.md`, a change is not complete until `bun run test` passes and affected tests are updated.
5. **Commit after every task.** Do not batch.

---

## Task 1: Envelope parser and question heuristic

**Files:**
- Create: `shared/session/agentEnvelope.ts`
- Create: `src/lib/__tests__/agentEnvelope.test.ts`
- Read for reference (do not edit yet): `src/lib/teammateMessage.ts`, `src/lib/__tests__/teammateMessage.test.ts`

**Step 1: Write the failing test**

```ts
// src/lib/__tests__/agentEnvelope.test.ts
import { describe, it, expect } from "vitest"
import { parseAgentEnvelope, looksLikeQuestion } from "../../../shared/session/agentEnvelope"

describe("parseAgentEnvelope", () => {
  it("unwraps an <agent-message> envelope and returns the sender", () => {
    const r = parseAgentEnvelope(`<agent-message from="csp-and-proxy">\nbody text\n</agent-message>`)
    expect(r.sender).toBe("csp-and-proxy")
    expect(r.body).toBe("body text")
  })

  it("unwraps a <teammate-message> envelope via teammate_id", () => {
    const r = parseAgentEnvelope(`<teammate-message teammate_id="team-lead">hello</teammate-message>`)
    expect(r.sender).toBe("team-lead")
    expect(r.body).toBe("hello")
  })

  it("prefers the first envelope's sender when several are present", () => {
    const r = parseAgentEnvelope(
      `<agent-message from="a">one</agent-message>\n<agent-message from="b">two</agent-message>`,
    )
    expect(r.sender).toBe("a")
    expect(r.body).toBe("one\ntwo")
  })

  it("passes plain text through with a null sender", () => {
    const r = parseAgentEnvelope("just a prompt")
    expect(r.sender).toBeNull()
    expect(r.body).toBe("just a prompt")
  })

  it("leaves an unclosed tag alone rather than swallowing the rest", () => {
    const r = parseAgentEnvelope(`<agent-message from="x">no closing tag`)
    expect(r.sender).toBeNull()
    expect(r.body).toBe(`<agent-message from="x">no closing tag`)
  })
})

describe("looksLikeQuestion", () => {
  it("fires on an announced blocking question in the lead", () => {
    expect(looksLikeQuestion("payload-batch-2 - one blocking question on finding #1.\nDetail follows.")).toBe(true)
  })

  it("fires on a question mark near the end", () => {
    expect(looksLikeQuestion("I did the work. ".repeat(20) + "Should I also land the middleware hunk?")).toBe(true)
  })

  it("does not fire on a done report", () => {
    expect(looksLikeQuestion("payload-batch-2 done. bun run verify is PASS across all four gates.")).toBe(false)
  })

  it("does not fire on a question mark only in the opening paragraph", () => {
    expect(looksLikeQuestion("Remember the CSP question? I answered it myself. " + "Work log follows. ".repeat(30))).toBe(false)
  })

  it("returns false for empty input", () => {
    expect(looksLikeQuestion("   ")).toBe(false)
  })
})
```

**Step 2: Run it and confirm it fails**

Run: `bun run test -- agentEnvelope`
Expected: FAIL — `Failed to resolve import "../../../shared/session/agentEnvelope"`.

**Step 3: Write the implementation**

```ts
// shared/session/agentEnvelope.ts

/**
 * Parsing for the envelopes that wrap inter-agent messages.
 *
 * Current Claude Code writes structured `attachment.origin` metadata alongside
 * the envelope, so turnBuilder reads that first. This regex path exists for
 * records written before `origin` — and for the queue-operation copy, which
 * carries the raw text and nothing else.
 *
 *   <agent-message from="worker-name"> ...markdown body... </agent-message>
 *   <teammate-message teammate_id="team-lead"> ...markdown body... </teammate-message>
 */

const ENVELOPE_RE = /<(agent-message|teammate-message)([^>]*)>([\s\S]*?)<\/\1>/g
const SENDER_RE = /(?:\bfrom|\bteammate_id)="([^"]*)"/

export interface ParsedAgentEnvelope {
  /** Sender named by the first envelope, or null when there is none. */
  sender: string | null
  /** Text with every envelope unwrapped. Unchanged when no envelope matched. */
  body: string
}

export function parseAgentEnvelope(text: string): ParsedAgentEnvelope {
  let sender: string | null = null
  let matched = false

  const unwrapped = text.replace(ENVELOPE_RE, (_full, _tag: string, attrs: string, inner: string) => {
    matched = true
    if (sender === null) {
      const m = attrs.match(SENDER_RE)
      if (m?.[1]) sender = m[1]
    }
    return inner.trim()
  })

  return matched ? { sender, body: unwrapped.trim() } : { sender: null, body: text }
}

/** Phrases that announce a question up front, checked against the opening. */
const ASK_PHRASES = [
  "blocking question",
  "before i touch",
  "should i",
  "tell me one of",
  "let me know",
  "your call",
  "who owns",
  "confirm whether",
]

const LEAD_CHARS = 200
/** Questions land at the end of a report; only the tail counts for "?". */
const TAIL_FRACTION = 0.75

/**
 * Whether a message reads as asking the reader for something.
 *
 * This is the one guessed signal in agent mail, so callers must gate it on the
 * message also being unanswered — a false positive then disappears as soon as
 * the reader replies, and can never go stale on screen.
 */
export function looksLikeQuestion(body: string): boolean {
  const trimmed = body.trim()
  if (!trimmed) return false

  const lower = trimmed.toLowerCase()
  if (ASK_PHRASES.some((phrase) => lower.slice(0, LEAD_CHARS).includes(phrase))) return true

  return trimmed.slice(Math.floor(trimmed.length * TAIL_FRACTION)).includes("?")
}
```

**Step 4: Run and confirm green**

Run: `bun run test -- agentEnvelope`
Expected: PASS, 10 tests.

**Step 5: Commit**

```bash
git add shared/session/agentEnvelope.ts src/lib/__tests__/agentEnvelope.test.ts
git commit -m "feat: add agent envelope parser and question heuristic"
```

---

## Task 2: Widen the attachment type and add the block kind

**Files:**
- Modify: `shared/session/types.ts:278-285` (the `AttachmentMessage` interface)
- Modify: `shared/session/types.ts:335-350` (the `TurnContentBlock` union)

No test of its own — types are exercised by Task 3. This task must leave `bun run typecheck` green.

**Step 1: Widen `AttachmentMessage`**

Replace the `attachment` field:

```ts
export interface AttachmentMessage extends BaseMessage {
  type: "attachment"
  attachment?: {
    type?: string
    prompt?: string | ContentBlock[] | null
    commandMode?: string
    timestamp?: string
    /**
     * Who queued this prompt. `"human"` is the reader typing mid-turn;
     * `"peer"` is another agent sending this session a message. `body` is the
     * message with its envelope already stripped, so it beats re-parsing
     * `prompt`. Absent on records written before Claude Code added the field.
     */
    origin?: {
      kind?: string
      from?: string
      name?: string
      senderTaskId?: string
      body?: string
    } | null
  } | null
}
```

**Step 2: Add the block kind**

In the `TurnContentBlock` union, immediately after the `queued_prompt` line:

```ts
  | { kind: "queued_prompt"; content: string; timestamp?: string }
  /**
   * A message another agent sent this session mid-turn. Distinct from
   * `queued_prompt`, which is the reader's own text. `reply` is filled by the
   * pairing pass when a later SendMessage answered this sender.
   */
  | {
      kind: "agent_message"
      sender: string
      senderTaskId: string | null
      body: string
      timestamp?: string
      reply?: { summary: string; timestamp: string }
    }
```

**Step 3: Typecheck**

Run: `bun run typecheck`
Expected: FAIL — several exhaustive `switch` statements on `block.kind` now miss a case. Note every file the compiler names; Task 6 fixes the serializers. If a switch has no `default`, add the case now returning the obvious mapping.

**Step 4: Sync the mirror**

Run: `bun run sync-cogpit-memory && bun run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add shared/session/types.ts packages/cogpit-memory/src/lib/types.ts
git commit -m "feat: add agent_message block kind and attachment origin type"
```

---

## Task 3: turnBuilder emits agent_message

**Files:**
- Modify: `shared/session/turnBuilder.ts:62-72` (`queuedCommandPromptText`)
- Modify: `shared/session/turnBuilder.ts:346-352` (`pendingQueuedPrompts` declaration)
- Modify: `shared/session/turnBuilder.ts:377-386` (`flushPendingQueuedPrompts`)
- Modify: `shared/session/turnBuilder.ts:481-510` (the two push sites)
- Test: `src/lib/__tests__/turnBuilder.test.ts`

**Step 1: Write the failing tests**

Append to `src/lib/__tests__/turnBuilder.test.ts`. Reuse the file's existing fixture helpers; match their style for constructing raw messages.

```ts
describe("agent mail", () => {
  const peerAttachment = (name: string, body: string, taskId = "task-1") => ({
    type: "attachment" as const,
    timestamp: "2026-08-21T19:26:25.853Z",
    attachment: {
      type: "queued_command",
      commandMode: "prompt",
      prompt: `<agent-message from="${name}">\n${body}\n</agent-message>`,
      origin: { kind: "peer", from: name, name, senderTaskId: taskId, body },
    },
  })

  it("emits agent_message for a peer origin, with the envelope stripped", () => {
    const session = buildSession(withBase([
      userMsg("start"),
      textAssistant("working"),
      peerAttachment("csp-and-proxy", "one blocking question on finding #1."),
      textAssistant("done"),
    ]))
    const block = session.turns[0].contentBlocks.find((b) => b.kind === "agent_message")
    expect(block).toBeDefined()
    if (block?.kind !== "agent_message") return
    expect(block.sender).toBe("csp-and-proxy")
    expect(block.senderTaskId).toBe("task-1")
    expect(block.body).toBe("one blocking question on finding #1.")
    expect(block.body).not.toContain("<agent-message")
  })

  it("keeps a human origin as queued_prompt", () => {
    const attachment = peerAttachment("x", "check the tests too")
    attachment.attachment.origin = { kind: "human" } as never
    attachment.attachment.prompt = "check the tests too"
    const session = buildSession(withBase([
      userMsg("start"), textAssistant("working"), attachment, textAssistant("done"),
    ]))
    const kinds = session.turns[0].contentBlocks.map((b) => b.kind)
    expect(kinds).toContain("queued_prompt")
    expect(kinds).not.toContain("agent_message")
  })

  it("falls back to the envelope when origin is absent", () => {
    const attachment = peerAttachment("vehicle-batch", "half-blocked on a decision")
    delete (attachment.attachment as { origin?: unknown }).origin
    const session = buildSession(withBase([
      userMsg("start"), textAssistant("working"), attachment, textAssistant("done"),
    ]))
    const block = session.turns[0].contentBlocks.find((b) => b.kind === "agent_message")
    if (block?.kind !== "agent_message") throw new Error("expected agent_message")
    expect(block.sender).toBe("vehicle-batch")
    expect(block.senderTaskId).toBeNull()
    expect(block.body).toBe("half-blocked on a decision")
  })

  it("leaves a plain queued prompt with no origin as queued_prompt", () => {
    const attachment = peerAttachment("x", "y")
    delete (attachment.attachment as { origin?: unknown }).origin
    attachment.attachment.prompt = "also check the tests"
    const session = buildSession(withBase([
      userMsg("start"), textAssistant("working"), attachment, textAssistant("done"),
    ]))
    expect(session.turns[0].contentBlocks.map((b) => b.kind)).toContain("queued_prompt")
  })
})
```

**Step 2: Run and confirm failure**

Run: `bun run test -- turnBuilder`
Expected: FAIL — no `agent_message` blocks produced.

**Step 3: Implement**

Replace `queuedCommandPromptText` (line 62) with:

```ts
interface QueuedPromptSource {
  /**
   * The prompt exactly as written. This is the enqueue ledger's key — the
   * queue-operation copy and this attachment copy only reconcile on an exact
   * raw match, so never substitute the stripped body here.
   */
  raw: string
  /** Peer sender, or null when the reader typed this. */
  sender: string | null
  senderTaskId: string | null
  /** Envelope-free body. Equals `raw` when there was no envelope. */
  body: string
}

function queuedCommandPrompt(msg: RawMessage): QueuedPromptSource | null {
  if (!isAttachmentMessage(msg)) return null
  const attachment = msg.attachment
  if (!attachment || attachment.type !== "queued_command") return null
  if (attachment.commandMode !== "prompt") return null
  const prompt = attachment.prompt
  if (prompt == null) return null
  const raw = typeof prompt === "string" ? prompt : extractTextFromContent(prompt)
  if (!isVisibleQueuedPrompt(raw)) return null

  const origin = attachment.origin
  if (origin?.kind === "peer") {
    const sender = origin.name ?? origin.from ?? null
    if (sender) {
      return {
        raw,
        sender,
        senderTaskId: origin.senderTaskId ?? null,
        body: origin.body ?? parseAgentEnvelope(raw).body,
      }
    }
  }
  if (origin?.kind === "human") {
    return { raw, sender: null, senderTaskId: null, body: raw }
  }

  // Pre-`origin` records: the envelope in the text is all we have.
  const parsed = parseAgentEnvelope(raw)
  return { raw, sender: parsed.sender, senderTaskId: null, body: parsed.body }
}
```

Add the import at the top of the file:

```ts
import { parseAgentEnvelope } from "./agentEnvelope"
```

Widen `pendingQueuedPrompts` (line 346):

```ts
  const pendingQueuedPrompts: Array<{
    turn: Turn
    /** Ledger key and `queued_prompt` content. */
    content: string
    timestamp?: string
    sender: string | null
    senderTaskId: string | null
    body: string
  }> = []
```

Rewrite `flushPendingQueuedPrompts` (line 377):

```ts
  function flushPendingQueuedPrompts() {
    for (const prompt of pendingQueuedPrompts) {
      prompt.turn.contentBlocks.push(
        prompt.sender
          ? {
              kind: "agent_message",
              sender: prompt.sender,
              senderTaskId: prompt.senderTaskId,
              body: prompt.body,
              timestamp: prompt.timestamp,
            }
          : {
              kind: "queued_prompt",
              content: prompt.content,
              timestamp: prompt.timestamp,
            },
      )
    }
    pendingQueuedPrompts.length = 0
  }
```

Update the queue-operation push site (line 482) — this record has no `origin`, so the regex is the only option:

```ts
      if (current && msg.operation === "enqueue" && isVisibleQueuedPrompt(msg.content)) {
        const parsed = parseAgentEnvelope(msg.content)
        pendingQueuedPrompts.push({
          turn: current,
          content: msg.content,
          timestamp: msg.timestamp,
          sender: parsed.sender,
          senderTaskId: null,
          body: parsed.body,
        })
        noteEnqueueSourced(current, msg.content)
      }
```

Update the attachment push site (line 501):

```ts
    if (isAttachmentMessage(msg)) {
      const queued = queuedCommandPrompt(msg)
      if (current && queued !== null && !consumeEnqueueSourced(current, queued.raw)) {
        pendingQueuedPrompts.push({
          turn: current,
          content: queued.raw,
          timestamp: msg.attachment?.timestamp ?? msg.timestamp,
          sender: queued.sender,
          senderTaskId: queued.senderTaskId,
          body: queued.body,
        })
      }
      continue
    }
```

**Step 4: Run**

Run: `bun run test -- turnBuilder && bun run sync-cogpit-memory && bun run typecheck`
Expected: PASS. If any pre-existing turnBuilder test now fails, read it before changing it — a human-typed prompt must still produce `queued_prompt`, and a regression there is a real bug in the branch above, not a stale expectation.

**Step 5: Commit**

```bash
git add shared/session/turnBuilder.ts packages/cogpit-memory/src/lib/ src/lib/__tests__/turnBuilder.test.ts
git commit -m "feat: emit agent_message blocks for peer-origin queued prompts"
```

---

## Task 4: Dedupe repeated agent messages

**Context:** the sample data contains the identical body enqueued twice 3s apart, and a full replay of two messages hours later. `senderTaskId` makes this exact.

**Files:**
- Modify: `shared/session/turnBuilder.ts` (`flushPendingQueuedPrompts`)
- Test: `src/lib/__tests__/turnBuilder.test.ts`

**Step 1: Failing tests**

```ts
  it("renders a repeated peer message once per turn", () => {
    const session = buildSession(withBase([
      userMsg("start"), textAssistant("working"),
      peerAttachment("certified-status-fix", "heads-up", "task-9"),
      peerAttachment("certified-status-fix", "heads-up", "task-9"),
      textAssistant("done"),
    ]))
    expect(session.turns[0].contentBlocks.filter((b) => b.kind === "agent_message")).toHaveLength(1)
  })

  it("keeps two distinct messages from the same sender", () => {
    const session = buildSession(withBase([
      userMsg("start"), textAssistant("working"),
      peerAttachment("csp-and-proxy", "one blocking question", "task-1"),
      peerAttachment("csp-and-proxy", "batch-2 done", "task-2"),
      textAssistant("done"),
    ]))
    expect(session.turns[0].contentBlocks.filter((b) => b.kind === "agent_message")).toHaveLength(2)
  })

  it("still renders the same human prompt twice when queued twice", () => {
    // Guards the existing count-don't-set behaviour in the enqueue ledger.
    const session = buildSession(withBase([
      userMsg("start"), textAssistant("working"),
      queueEnqueue("ping"), queueEnqueue("ping"),
      textAssistant("done"),
    ]))
    expect(session.turns[0].contentBlocks.filter((b) => b.kind === "queued_prompt")).toHaveLength(2)
  })
```

**Step 2: Run, confirm the first fails**

Run: `bun run test -- turnBuilder`

**Step 3: Implement**

In `flushPendingQueuedPrompts`, track what the turn has already received:

```ts
  function flushPendingQueuedPrompts() {
    // A replayed queue writes the same peer message again, sometimes seconds
    // later and sometimes hours later on resume. senderTaskId identifies it
    // exactly; the body is the fallback for pre-`origin` records.
    const seenAgentMessages = new Map<Turn, Set<string>>()

    for (const prompt of pendingQueuedPrompts) {
      if (prompt.sender) {
        let seen = seenAgentMessages.get(prompt.turn)
        if (!seen) {
          seen = new Set(
            prompt.turn.contentBlocks
              .filter((b) => b.kind === "agent_message")
              .map((b) => (b.kind === "agent_message" ? (b.senderTaskId ?? `${b.sender} ${b.body}`) : "")),
          )
          seenAgentMessages.set(prompt.turn, seen)
        }
        const key = prompt.senderTaskId ?? `${prompt.sender} ${prompt.body}`
        if (seen.has(key)) continue
        seen.add(key)

        prompt.turn.contentBlocks.push({
          kind: "agent_message",
          sender: prompt.sender,
          senderTaskId: prompt.senderTaskId,
          body: prompt.body,
          timestamp: prompt.timestamp,
        })
        continue
      }

      prompt.turn.contentBlocks.push({
        kind: "queued_prompt",
        content: prompt.content,
        timestamp: prompt.timestamp,
      })
    }
    pendingQueuedPrompts.length = 0
  }
```

**Step 4: Run**

Run: `bun run test -- turnBuilder && bun run sync-cogpit-memory`
Expected: PASS, including the human-prompt-twice guard.

**Step 5: Commit**

```bash
git add shared/session/turnBuilder.ts packages/cogpit-memory/src/lib/ src/lib/__tests__/turnBuilder.test.ts
git commit -m "feat: dedupe replayed peer messages by senderTaskId"
```

---

## Task 5: Pair replies

**Files:**
- Modify: `shared/session/turnBuilder.ts` (new pass, run once after turns are built — find where `buildSession` returns and call it just before)
- Test: `src/lib/__tests__/turnBuilder.test.ts`

**Step 1: Failing tests**

```ts
  const sendMessage = (to: string, summary: string, id: string) =>
    toolUseAssistant("SendMessage", { to, summary, message: "..." }, id)

  it("attaches the SendMessage that answered a peer message", () => {
    const session = buildSession(withBase([
      userMsg("start"), textAssistant("working"),
      peerAttachment("csp-and-proxy", "one blocking question", "task-1"),
      sendMessage("csp-and-proxy", "Answered your question", "sm-1"),
      textAssistant("done"),
    ]))
    const block = session.turns[0].contentBlocks.find((b) => b.kind === "agent_message")
    if (block?.kind !== "agent_message") throw new Error("expected agent_message")
    expect(block.reply?.summary).toBe("Answered your question")
  })

  it("leaves a message unanswered when no SendMessage targets that sender", () => {
    const session = buildSession(withBase([
      userMsg("start"), textAssistant("working"),
      peerAttachment("csp-and-proxy", "one blocking question", "task-1"),
      sendMessage("someone-else", "unrelated", "sm-1"),
      textAssistant("done"),
    ]))
    const block = session.turns[0].contentBlocks.find((b) => b.kind === "agent_message")
    if (block?.kind !== "agent_message") throw new Error("expected agent_message")
    expect(block.reply).toBeUndefined()
  })

  it("does not pair a SendMessage that preceded the message", () => {
    const session = buildSession(withBase([
      userMsg("start"), textAssistant("working"),
      sendMessage("csp-and-proxy", "go do batch 2", "sm-1"),
      peerAttachment("csp-and-proxy", "one blocking question", "task-1"),
      textAssistant("done"),
    ]))
    const block = session.turns[0].contentBlocks.find((b) => b.kind === "agent_message")
    if (block?.kind !== "agent_message") throw new Error("expected agent_message")
    expect(block.reply).toBeUndefined()
  })

  it("pairs two messages from one sender to their two replies in order", () => {
    const session = buildSession(withBase([
      userMsg("start"), textAssistant("working"),
      peerAttachment("w", "first", "t1"),
      peerAttachment("w", "second", "t2"),
      sendMessage("w", "re first", "sm-1"),
      sendMessage("w", "re second", "sm-2"),
      textAssistant("done"),
    ]))
    const blocks = session.turns[0].contentBlocks.filter((b) => b.kind === "agent_message")
    expect(blocks.map((b) => (b.kind === "agent_message" ? b.reply?.summary : null)))
      .toEqual(["re first", "re second"])
  })
```

**Step 2: Run, confirm failure**

Run: `bun run test -- turnBuilder`

**Step 3: Implement**

Add near the other helpers in `turnBuilder.ts`:

```ts
/**
 * Attach each peer message to the SendMessage that answered it.
 *
 * Walks blocks in chronological order holding the still-unanswered messages per
 * sender, so a reply claims the oldest outstanding message from that sender and
 * pairing only ever runs forward in time. A SendMessage sent *before* any
 * inbound message is an instruction, not a reply, and must not pair.
 */
function pairAgentMessageReplies(turns: Turn[]): void {
  const unanswered = new Map<string, Array<Extract<TurnContentBlock, { kind: "agent_message" }>>>()

  for (const turn of turns) {
    for (const block of turn.contentBlocks) {
      if (block.kind === "agent_message") {
        const queue = unanswered.get(block.sender)
        if (queue) queue.push(block)
        else unanswered.set(block.sender, [block])
        continue
      }
      if (block.kind !== "tool_calls") continue

      for (const call of block.toolCalls) {
        if (call.name !== "SendMessage") continue
        const input = call.input as { to?: unknown; summary?: unknown } | null
        const to = typeof input?.to === "string" ? input.to : null
        if (!to) continue
        const waiting = unanswered.get(to)
        const target = waiting?.shift()
        if (!target) continue
        target.reply = {
          summary: typeof input?.summary === "string" ? input.summary : "",
          timestamp: block.timestamp ?? "",
        }
      }
    }
  }
}
```

Call it once, immediately before `buildSession` returns its result:

```ts
  pairAgentMessageReplies(turns)
```

**Step 4: Run**

Run: `bun run test -- turnBuilder && bun run sync-cogpit-memory && bun run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add shared/session/turnBuilder.ts packages/cogpit-memory/src/lib/ src/lib/__tests__/turnBuilder.test.ts
git commit -m "feat: pair peer messages with the SendMessage that answered them"
```

---

## Task 6: Serialization and mirror sync

**Files:**
- Modify: `server/routes/session-context.ts:182` (add a case beside `queued_prompt`)
- Modify: `packages/cogpit-memory/src/commands/context.ts:185` (same case)
- Modify: any other file the Task 2 typecheck named

**Step 1: Add the case to both serializers**

```ts
    case "agent_message":
      return {
        kind: "agent_message" as const,
        sender: block.sender,
        senderTaskId: block.senderTaskId,
        body: block.body,
        reply: block.reply ?? null,
        timestamp: block.timestamp ?? null,
      }
```

`packages/cogpit-memory/src/commands/context.ts` is **not** generated — edit it by hand. Only `packages/cogpit-memory/src/lib/` is a mirror.

**Step 2: Verify**

Run: `bun run typecheck && bun run check:cogpit-memory-sync && bun run test`
Expected: PASS on all three.

**Step 3: Commit**

```bash
git add server/routes/session-context.ts packages/cogpit-memory/src/commands/context.ts
git commit -m "feat: serialize agent_message blocks in session context APIs"
```

---

## Task 7: Retire teammateMessage.ts

**Files:**
- Delete: `src/lib/teammateMessage.ts`
- Delete: `src/lib/__tests__/teammateMessage.test.ts` (its cases now live in `agentEnvelope.test.ts` — confirm coverage before deleting, and port anything missing)
- Modify: `src/components/StickyPromptBanner.tsx:6,29`
- Modify: `src/components/timeline/UserMessage.tsx:7,175,224-225,276-283`

**Step 1: Port any uncovered cases**

Read `src/lib/__tests__/teammateMessage.test.ts`. For each assertion not already covered in `agentEnvelope.test.ts`, add an equivalent. Only then delete the old file.

**Step 2: Repoint the two consumers**

`StickyPromptBanner.tsx`:

```ts
import { parseAgentEnvelope } from "../../shared/session/agentEnvelope"
// ...
const { body: unwrapped } = parseAgentEnvelope(raw)
```

`UserMessage.tsx` — the old call destructured `{ teammateId, isTeammate, text }`:

```ts
import { parseAgentEnvelope } from "../../../shared/session/agentEnvelope"
// ...
const { sender: teammateId, body: unwrappedText } = useMemo(() => parseAgentEnvelope(rawText), [rawText])
const isTeammate = teammateId !== null
```

Leave the teammate `Badge` in `UserMessage` as-is. It still covers envelopes that arrive as ordinary user records rather than queued attachments.

**Step 3: Delete and verify**

```bash
git rm src/lib/teammateMessage.ts src/lib/__tests__/teammateMessage.test.ts
bun run test && bun run typecheck && bun run lint
```
Expected: PASS. Any remaining import of `teammateMessage` is a lint/typecheck error — fix it rather than restoring the file.

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: fold teammateMessage into shared agentEnvelope"
```

---

## Task 8: The card — identity, subject, preview

**Files:**
- Create: `src/components/timeline/AgentMessageCard.tsx`
- Create: `src/components/timeline/__tests__/AgentMessageCard.test.tsx`
- Reference for style conventions: `src/components/timeline/UserMessage.tsx`, `src/components/timeline/RecapBanner.tsx`

Build the card in three passes: identity + text here, reply footer in Task 10, chip in Task 11, dot in Task 12. Do not try to land it all at once.

**Step 1: Failing tests**

```tsx
import { describe, it, expect } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { AgentMessageCard } from "../AgentMessageCard"

const BODY = [
  "payload-batch-2 done, except the one hunk in `src/middleware.ts` I said I'd hand you.",
  "",
  "`bun run verify --workspace payload-app` is PASS across lint, typecheck, test and coverage.",
].join("\n")

describe("AgentMessageCard", () => {
  it("shows the sender", () => {
    render(<AgentMessageCard sender="csp-and-proxy" senderTaskId="t1" body={BODY} timestamp="" />)
    expect(screen.getByText("csp-and-proxy")).toBeInTheDocument()
  })

  it("never renders the raw envelope", () => {
    const { container } = render(
      <AgentMessageCard sender="csp-and-proxy" senderTaskId="t1" body={BODY} timestamp="" />,
    )
    expect(container.textContent).not.toContain("<agent-message")
  })

  it("splits the first line into a subject and the rest into a preview", () => {
    render(<AgentMessageCard sender="w" senderTaskId={null} body={BODY} timestamp="" />)
    expect(screen.getByTestId("agent-message-subject").textContent)
      .toContain("payload-batch-2 done")
    expect(screen.getByTestId("agent-message-preview").textContent)
      .toContain("is PASS across lint")
  })

  it("reveals the full body on expand", () => {
    render(<AgentMessageCard sender="w" senderTaskId={null} body={BODY} timestamp="" />)
    expect(screen.queryByTestId("agent-message-body")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /expand/i }))
    expect(screen.getByTestId("agent-message-body")).toBeInTheDocument()
  })

  it("gives the same sender the same accent every time", () => {
    const { container: a } = render(<AgentMessageCard sender="w" senderTaskId={null} body="x" timestamp="" />)
    const { container: b } = render(<AgentMessageCard sender="w" senderTaskId={null} body="y" timestamp="" />)
    const railOf = (c: HTMLElement) => c.querySelector("[data-agent-rail]")?.getAttribute("style")
    expect(railOf(a)).toBe(railOf(b))
  })

  it("handles a single-line body with no preview", () => {
    render(<AgentMessageCard sender="w" senderTaskId={null} body="just one line" timestamp="" />)
    expect(screen.getByTestId("agent-message-subject").textContent).toContain("just one line")
    expect(screen.queryByTestId("agent-message-preview")).not.toBeInTheDocument()
  })
})
```

**Step 2: Run, confirm failure**

Run: `bun run test -- AgentMessageCard`

**Step 3: Implement**

Key requirements, in priority order:

- **Subject/preview split.** First non-empty line is the subject; everything after it, flattened to plain text, is the preview. Flatten by stripping fences, backticks, list markers, and link syntax — the preview is a teaser, not markdown.
- **Clamp with CSS, never `.slice()`.** Subject `line-clamp-2`, preview `line-clamp-2`. This is the fix for the mid-word cut in the original report; a character slice would reintroduce it.
- **Deterministic accent.** Hash the sender name to an index into a fixed palette, applied as a CSS custom property on a 3px left rail and on the sender name. Use `oklch(0.74 0.14 <hue>)` with hues spread across the wheel so adjacent agents stay distinguishable on the OLED theme. Put the hash in a tiny exported helper so the test can assert stability.
- **Expand** renders the full body through `ReactMarkdown` with `markdownComponents` / `markdownPlugins`, matching `UserMessage.tsx:395`.
- Accept optional `reply`, `isLive`, and `liveStatus` props now, unused until Tasks 10-12, so later tasks touch only the render.

**Step 4: Run**

Run: `bun run test -- AgentMessageCard`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/timeline/AgentMessageCard.tsx src/components/timeline/__tests__/AgentMessageCard.test.tsx
git commit -m "feat: add AgentMessageCard with sender identity and subject preview"
```

---

## Task 9: Wire the card into the timeline

**Files:**
- Modify: `src/components/timeline/TurnSection.tsx:519-533` (add a branch beside `queued_prompt`)
- Modify: `src/lib/turnFold.ts:21-25` (`PINNED_KINDS`)
- Modify: `src/lib/timelineHelpers.ts:20-24` (search)
- Test: `src/lib/__tests__/timelineHelpers.test.ts`, `src/lib/__tests__/turnFold.test.ts`

**Step 1: Failing tests**

```ts
// timelineHelpers.test.ts
it("matches an agent message by sender and by body", () => {
  const turn = makeTurn({
    contentBlocks: [{ kind: "agent_message", sender: "csp-and-proxy", senderTaskId: null, body: "lenderdesk hardening" }],
  })
  expect(matchesSearch(turn, "csp-and")).toBe(true)
  expect(matchesSearch(turn, "lenderdesk")).toBe(true)
  expect(matchesSearch(turn, "nothing here")).toBe(false)
})

// turnFold.test.ts
it("never folds an agent message away", () => {
  const blocks = [
    { kind: "thinking", blocks: [] },
    { kind: "agent_message", sender: "w", senderTaskId: null, body: "b" },
    { kind: "tool_calls", toolCalls: [{ name: "Read", input: {} }] },
    { kind: "text", text: ["done"] },
  ] as TurnContentBlock[]
  const plan = planTurnFold(blocks)
  expect(plan.foldedIndices).not.toContain(1)
})
```

**Step 2: Run, confirm failure**

**Step 3: Implement**

`turnFold.ts` — add to `PINNED_KINDS`. An agent asking you a question is not "work":

```ts
const PINNED_KINDS: ReadonlySet<TurnContentBlock["kind"]> = new Set([
  "queued_prompt",
  "agent_message",
  "plan_mode",
  "recap",
])
```

`timelineHelpers.ts` — extend the block loop:

```ts
  for (const block of turn.contentBlocks) {
    if (block.kind === "queued_prompt" && block.content.toLowerCase().includes(q)) return true
    if (block.kind === "agent_message"
      && (block.sender.toLowerCase().includes(q) || block.body.toLowerCase().includes(q))) {
      return true
    }
  }
```

`TurnSection.tsx` — a branch directly after the `queued_prompt` branch:

```tsx
    if (block.kind === "agent_message") {
      elements.push(
        <AgentMessageCard
          key={keyFor(block, i)}
          sender={block.sender}
          senderTaskId={block.senderTaskId}
          body={block.body}
          reply={block.reply}
          timestamp={block.timestamp ?? ""}
          compact={isMobile}
        />
      )
      i++
      continue
    }
```

**Step 4: Verify in the real app**

Run `bun run test && bun run typecheck`, then start the app and open a session containing peer messages — `~/.claude/projects/-Users-gentritbiba-Insync-.../honest-cms/ddb6fc34-dc05-4ab5-87f3-9587bf961357.jsonl` has eight, from `csp-and-proxy`, `vehicle-batch`, and `certified-status-fix`. Confirm no `<agent-message` text appears anywhere and each card names its sender.

Use the `run` skill to launch the app, then agent-browser for the screenshot. Close the browser when done.

**Step 5: Commit**

```bash
git add src/components/timeline/TurnSection.tsx src/lib/turnFold.ts src/lib/timelineHelpers.ts src/lib/__tests__/
git commit -m "feat: render agent messages in the timeline"
```

---

## Task 10: Reply state footer

**Files:**
- Modify: `src/components/timeline/AgentMessageCard.tsx`
- Modify: `src/components/timeline/__tests__/AgentMessageCard.test.tsx`

**Step 1: Failing tests**

```tsx
it("shows the reply summary when the message was answered", () => {
  render(<AgentMessageCard sender="w" senderTaskId={null} body="b" timestamp="2026-08-21T19:26:25Z"
    reply={{ summary: "Fixed the type error you flagged", timestamp: "2026-08-21T19:26:47Z" }} />)
  expect(screen.getByText(/Fixed the type error you flagged/)).toBeInTheDocument()
  expect(screen.getByText(/replied/i)).toBeInTheDocument()
})

it("shows a ticking wait only while the session is live", () => {
  render(<AgentMessageCard sender="w" senderTaskId={null} body="b" timestamp="2026-08-21T19:26:25Z" isLive />)
  expect(screen.getByText(/Awaiting your reply/i)).toBeInTheDocument()
})

it("shows a flat never-answered state for a historical session", () => {
  render(<AgentMessageCard sender="w" senderTaskId={null} body="b" timestamp="2026-08-21T19:26:25Z" />)
  expect(screen.getByText(/Never answered/i)).toBeInTheDocument()
  expect(screen.queryByText(/Awaiting your reply/i)).not.toBeInTheDocument()
})
```

**Step 2-4:** implement, run, confirm green. Compute elapsed with the existing `formatDuration` from `@/lib/format`; reuse `useElapsedTimer` (`src/hooks/useElapsedTimer.ts`) for the live tick rather than writing a new interval.

`isLive` comes from the same source `TurnSection` already uses for `isAgentActive` — pass it through in `TurnSection.tsx`.

**Step 5: Commit**

```bash
git commit -am "feat: show reply state on agent messages"
```

---

## Task 11: The NEEDS YOU chip

**Files:**
- Modify: `src/components/timeline/AgentMessageCard.tsx`
- Modify: `src/components/timeline/__tests__/AgentMessageCard.test.tsx`

**Step 1: Failing tests**

```tsx
const QUESTION = "payload-batch-2 - one blocking question on finding #1.\nDetail follows."

it("flags an unanswered question", () => {
  render(<AgentMessageCard sender="w" senderTaskId={null} body={QUESTION} timestamp="" />)
  expect(screen.getByText(/needs you/i)).toBeInTheDocument()
})

it("drops the flag once the question was answered", () => {
  render(<AgentMessageCard sender="w" senderTaskId={null} body={QUESTION} timestamp=""
    reply={{ summary: "answered", timestamp: "" }} />)
  expect(screen.queryByText(/needs you/i)).not.toBeInTheDocument()
})

it("does not flag a done report", () => {
  render(<AgentMessageCard sender="w" senderTaskId={null} body="batch-2 done, verify is PASS." timestamp="" />)
  expect(screen.queryByText(/needs you/i)).not.toBeInTheDocument()
})
```

**Step 2-4:** implement using `looksLikeQuestion` from `shared/session/agentEnvelope`. The chip renders only when `looksLikeQuestion(body) && !reply`. Both conditions — a chip that survives your reply is the failure mode that makes the signal untrustworthy.

**Step 5: Commit**

```bash
git commit -am "feat: flag unanswered agent questions"
```

---

## Task 12: Liveness dot

**Files:**
- Modify: `src/components/timeline/AgentMessageCard.tsx`
- Modify: `src/components/timeline/__tests__/AgentMessageCard.test.tsx`

No server work. `useSessionInventoryOptional()` (`src/contexts/SessionInventoryContext.tsx:244`) returns `ActiveSessionInfo[]`, each already carrying `agentName`, `teamName`, and `agentStatus`.

**Step 1: Failing tests**

```tsx
it("shows no dot when the sender resolves to nothing", () => {
  render(<AgentMessageCard sender="ghost" senderTaskId={null} body="b" timestamp="" />)
  expect(screen.queryByTestId("agent-liveness")).not.toBeInTheDocument()
})

it("shows a dot when exactly one live session matches the sender", () => {
  renderWithInventory([{ agentName: "w", teamName: "t", agentStatus: "working" }],
    <AgentMessageCard sender="w" senderTaskId={null} body="b" timestamp="" />)
  expect(screen.getByTestId("agent-liveness")).toBeInTheDocument()
})

it("shows no dot when two sessions share the sender name", () => {
  renderWithInventory([
    { agentName: "w", teamName: "t1", agentStatus: "working" },
    { agentName: "w", teamName: "t2", agentStatus: "idle" },
  ], <AgentMessageCard sender="w" senderTaskId={null} body="b" timestamp="" />)
  expect(screen.queryByTestId("agent-liveness")).not.toBeInTheDocument()
})
```

`renderWithInventory` is a local helper wrapping the component in a mocked `SessionInventoryContext.Provider`. Mock the context, not `fetch`.

**Step 2-4:** implement. Use `useSessionInventoryOptional()` so the card still renders with no provider (tests, standalone). Build `Map<agentName, ActiveSessionInfo[]>` and read it only when the array has exactly one entry. Ambiguous or missing means **no dot** — a grey "unknown" on every card is worse than silence.

**Step 5: Commit**

```bash
git commit -am "feat: show sender liveness on agent messages"
```

---

## Task 13: Full verification

**Step 1: Everything green**

```bash
bun run lint
bun run typecheck
bun run test
bun run check:cogpit-memory-sync
```

All four must pass. Fix anything red before continuing — per `CLAUDE.md`, fixing tests is part of the change, not a follow-up.

**Step 2: Real-session check**

Open the honest-cms session with eight peer messages and confirm, on screen:

- No `<agent-message` text anywhere.
- Each card names its sender, colored consistently across the session.
- The two `csp-and-proxy` messages render once each, not twice — this also confirms whether the empty timestamp-only card in the original report was the replay bug.
- The blocking-question message shows `NEEDS YOU` if it was never answered, and a reply summary if it was.
- Nothing is cut mid-word.

Screenshot it and include the image in your report.

**Step 3: Check for leftovers**

```bash
grep -rn "teammateMessage" --include="*.ts" --include="*.tsx" src server shared packages
grep -rn "queuedCommandPromptText" --include="*.ts" shared packages
```

Both must return nothing. Per `CLAUDE.md`, superseded code gets deleted, not left behind.

**Step 4: Report**

Summarize what landed, what the screenshots show, and anything the design got wrong on contact with the code. Do **not** push or open a PR without asking.

# Agent mail: rendering inbound messages from peer agents

Status: design agreed, not implemented
Date: 2026-08-25

## Problem

When a peer agent sends this session a message mid-turn, the timeline renders it
as a generic "Queued while working" card with the raw envelope in the body:

    <agent-message from="csp-and-proxy"> payload-batch-2 (CSP + lenderdesk
    hardening) — one blocking question on finding #1. I've traced every place …

Four defects:

1. **Wrong identity.** The card leads with a scheduling detail and buries the
   sender inside the body text. A message from a worker agent is styled
   identically to a prompt you typed.
2. **The envelope leaks.** `shared/session/types.ts` declares
   `AttachmentMessage.attachment` with four fields, so `turnBuilder.ts:63` reads
   `attachment.prompt` — the string with the tag still in it.
3. **Truncation is byte-dumb.** `UserMessage.tsx:410` slices at exactly 500
   chars, cutting mid-word (`bounded/quan…`) and potentially mid-code-fence.
4. **No state.** Nothing shows whether a message asked you something, whether
   you answered, or whether the sender is still running.

## What the data already gives us

Verified against `~/.claude/projects/…honest-cms/*.jsonl`.

A peer message is persisted as an `attachment` record:

```jsonc
{
  "type": "attachment",
  "attachment": {
    "type": "queued_command",
    "commandMode": "prompt",
    "prompt": "<agent-message from=\"certified-status-fix\">\n…</agent-message>",
    "origin": {
      "kind": "peer",
      "from": "certified-status-fix",
      "name": "certified-status-fix",
      "senderTaskId": "abc37dcb5cc01cf1c",
      "body": "Heads-up from the CPO/model-page status-expansion fix …"
    }
  }
}
```

Key facts:

- `origin.kind` is `"human"` or `"peer"` — the split we need is an explicit
  field, not something to infer.
- `origin.body` is the body with the envelope **already stripped**.
- `origin.senderTaskId` is a stable id: a better join key than the name,
  since names can collide across teams.
- Outbound replies are `SendMessage` tool_use calls carrying `to`, `summary`,
  and `message`. One sample file has 13 replies against 8 inbound messages, so
  reply pairing is derivable rather than guessed.
- `ActiveSessionInfo` (`src/components/LiveSessions/types.ts`) already carries
  `teamName`, `agentName`, and `agentStatus`, and the client already holds the
  whole list via `useSessionInventoryOptional()`. Liveness needs **no server
  change** — it is a client-side lookup by name.

Older records carry the envelope with no `origin`. The regex parser handles
those as a fallback only.

## Data layer

**`shared/session/types.ts`**

- Widen `AttachmentMessage.attachment` with
  `origin?: { kind?: string; from?: string; name?: string; senderTaskId?: string; body?: string } | null`.
- Add a block kind:

```ts
| { kind: "agent_message"; sender: string; senderTaskId: string | null
    body: string; timestamp?: string
    reply?: { summary: string; timestamp: string } }
```

`queued_prompt` keeps its current meaning: something *you* typed mid-turn.

**`shared/session/turnBuilder.ts`**

- `queuedCommandPromptText` becomes `queuedCommandPrompt`, returning
  `{ text, origin }`.
- Branch: `origin.kind === "peer"` → `agent_message` (using `origin.body`);
  `"human"` → `queued_prompt`; no `origin` → fall back to the envelope regex,
  then to `queued_prompt`.
- Dedupe `agent_message` on `(senderTaskId, body)` within a turn. The existing
  count-don't-set behaviour stays for `queued_prompt`, where typing the same
  thing twice is meaningful.
- Reply pass: walk turns in order holding `Map<sender, unanswered[]>`. Each
  `SendMessage` tool_use pops the oldest unanswered message from `input.to` and
  attaches `{summary, timestamp}`. Pairing only ever runs forward in time.

**`shared/session/agentEnvelope.ts`** (new)

- `parseAgentEnvelope(text)` handling `<agent-message from="…">` and
  `<teammate-message teammate_id="…">`.
- `looksLikeQuestion(body)`.
- Absorbs `src/lib/teammateMessage.ts`, **which is deleted**. `StickyPromptBanner.tsx`
  and `UserMessage.tsx` repoint their imports.

**`bun run sync-cogpit-memory`** regenerates `packages/cogpit-memory/src/lib/`.
Not optional — `check:cogpit-memory-sync` gates it.

**Serialization:** add the new kind to `server/routes/session-context.ts` and
`packages/cogpit-memory/src/commands/context.ts`.

## The card

`src/components/timeline/AgentMessageCard.tsx` (new), wired into `TurnSection`,
`turnFold`, and `timelineHelpers` (search matches sender *and* body).

Collapsed layout, three rows:

- **Header.** `↙ sender` in mono, colored by a hash of the sender name, with a
  matching 3px left rail. Same agent, same color, session-wide — that is what
  makes a wall of agent reports scannable. Liveness dot beside the name.
- **Subject + preview.** Line one of the body is the subject in foreground
  weight; the rest is a two-line muted preview. Both use CSS `line-clamp`, not
  character slicing: word boundaries come free, it reflows on mobile, and a cut
  cannot land inside a code fence. The preview is markdown flattened to plain
  text. Full markdown renders only on expand.
- **Footer.** The state line, plus a right-aligned expand affordance showing
  body size.

In the sample data every first line is already a real subject
("payload-batch-2 done, except the one hunk in `src/middleware.ts`…").

## The three signals

**Reply state — fact.** From the turnBuilder pairing pass. Renders as
`You replied 22s later · "<the SendMessage summary>"`. Unanswered in a *live*
session ticks `Awaiting your reply · 14m`; unanswered in a *historical* session
shows a flat `Never answered`. A counter ticking up from three weeks ago is
noise pretending to be urgency.

**Liveness — fact, best-effort.** `useSessionInventoryOptional()` returns
`ActiveSessionInfo[]`, each already carrying `agentName` and `agentStatus`.
Build `Map<agentName, agentStatus>` and look up `sender`. Amber pulse for a
running status, green for idle. No provider, no match, or an ambiguous match
across two teams means **no dot** — silence beats a grey "unknown" on every
card. No server work.

**Intent — the only guess, and gated.** `looksLikeQuestion(body)` fires on a `?`
in the last quarter of the body, or a lead-line phrase (`blocking question`,
`before I touch`, `should I`, `tell me one of`, `your call`, `who owns`).
Questions land at the end or get announced up front; both sampled messages do
exactly this.

The `NEEDS YOU` chip requires `looksLikeQuestion && !reply`. Both conditions.
A false positive disappears the moment you reply, so the chip cannot go stale —
which is the failure mode that would make you stop trusting it.

## Non-goals

- **No `DONE` / `PASS` / `FAILED` chips.** Those subjects already say it in
  plain English ("payload-batch-2 **done**", "currently **fails** on
  payload-app:typecheck"). A chip adds decoration, and a mislabeled `FAILED`
  costs more than it saves.
- **No grouped digest / inbox view.** Space was not the reported pain, and the
  card already fits four messages in the height today's layout gives two.
- **`agent_message` stays out of `useChatScroll`'s force-scroll path.** That
  path reconciles optimistic previews of prompts you typed. An agent messaging
  you mid-read should not yank the viewport.

## Testing

Per the repo testing policy, `bun run test` must pass and affected tests must be
updated as part of the change.

- **turnBuilder:** `peer` origin yields `agent_message`; `human` yields
  `queued_prompt`; absent origin with an envelope falls back to `agent_message`;
  absent origin with plain text yields `queued_prompt`; dedupe by
  `senderTaskId`; pairing is forward-only; an unpaired message stays awaiting.
- **`agentEnvelope.test.ts`:** absorbs the existing `teammateMessage.test.ts`
  cases, covers both tag forms, malformed and unclosed tags, and
  `looksLikeQuestion` positives and negatives.
- **`AgentMessageCard.test.tsx`:** no raw tag in rendered output; subject and
  preview split correctly; awaiting vs replied footer; chip appears only when
  question *and* unanswered.
- `src/lib/__tests__/parser.test.ts:140` is a human prompt with no envelope, so
  it stays green unchanged.
- `bun run check:cogpit-memory-sync` after touching `shared/session/`.

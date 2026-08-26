# Agent mail: rendering inbound messages from peer agents

Status: implemented
Date: 2026-08-25 (design), 2026-08-26 (last revised)

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
      "senderTaskId": "abc37dcb5cc01cf1c",   // the SENDER's task, not the message
      "body": "Heads-up from the CPO/model-page status-expansion fix …"
    }
  }
}
```

Key facts:

- `origin.kind` is `"human"` or `"peer"` — the split we need is an explicit
  field, not something to infer.
- `origin.body` is the body with the envelope **already stripped**.
- `origin.senderTaskId` identifies the **sending agent's task, not the
  message** — an earlier revision of this doc got that backwards. Verified: the
  two different `csp-and-proxy` messages (23:34 "one blocking question" and
  23:48 "batch-2 done") carry the *same* `senderTaskId=ada0f1591dbec7898`. It is
  useless as a per-message key and destructive as a dedup key. It is also `null`
  on every rendered block in practice, because the `queue-operation` enqueue
  arrives first and carries no `origin`, and the richer `attachment` copy is
  then dropped by the reconciliation ledger. The field is not carried on the
  block.
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
  (`senderTaskId` is typed because the record carries it; it is deliberately not
  propagated onto the block — see above.)
- Add a block kind:

```ts
| { kind: "agent_message"; sender: string; body: string; timestamp?: string
    reply?: { summary: string; timestamp: string } }
```

`queued_prompt` keeps its current meaning: something *you* typed mid-turn.

**`shared/session/turnBuilder.ts`**

- `queuedCommandPromptText` becomes `queuedCommandPrompt`, returning
  `{ text, origin }`.
- Branch: `origin.kind === "peer"` → `agent_message` (using `origin.body`);
  `"human"` → `queued_prompt`; no `origin` → fall back to the envelope regex,
  then to `queued_prompt`.
- **Dedup within one parse: none needed.** An earlier revision of this doc
  claimed the sample data showed the same peer message enqueued twice, 3-6s
  apart. That was a misreading: those records are `enqueue` -> `attachment` ->
  `remove` lifecycle triples for a *single* message, and the existing enqueue
  ledger (`enqueueSourcedPrompts`) already reconciles the two copies. Across
  three real sessions, a whole-file parse renders every peer message exactly
  once.
- **Dedup across pages: one narrow pass**, added by Task 14b after the claim
  above was found to have been measured on the wrong load path. That ledger is
  scoped to a single `buildTurns` call, so a page boundary falling between the
  enqueue and the attachment leaves both copies standing, and `prependTurns`
  dedupes by turn id, which cannot see two blocks in two different turns.
  `dedupeAgentMessages` in `src/lib/timelinePaging.ts` therefore drops a second
  `agent_message` that matches an earlier one on **(sender, body) and lands
  within 1s of it**. Both halves of that key are load-bearing:
  - Not `senderTaskId`: it names the sending agent's *task*, not the message,
    so an agent's question and its later done-report share one id and keying on
    it would silently drop the second (see above, and the Task 4 regression
    test).
  - Not (sender, body) alone: that is a whole-transcript key, so an agent that
    genuinely reported the same thing twice collapsed into one card however far
    apart the two were. The attachment inherits the enqueue's timestamp — 4 of
    the 6 enqueue/attachment pairs on disk agree to the millisecond, the other 2
    drift by 1ms — while the closest pair of genuinely distinct messages from
    one sender is 14m40s apart (`csp-and-proxy` in
    `…honest-cms/ddb6fc34….jsonl`). A block with no parseable timestamp is kept,
    since it cannot be shown to be a duplicate.
  - Not adjacency across the join either: the copies are not adjacent. In that
    same file the two halves of one message are 306 records apart, with the
    *next* message's enqueue sitting between them. File position drifts; the
    timestamps stay tied to the message.

  The requirement this pass answers is that the paged reader render a session
  identically to a whole-file `parseSession` — the same turns
  `/api/session-context` and the `cogpit-memory` CLI serve. That equivalence is
  asserted directly in `src/lib/__tests__/timelinePaging.test.ts`.
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
`You replied 22s later · "<the SendMessage summary>"`. An unanswered *question*
in a live session ticks `Awaiting your reply · 14m`; in a historical session it
shows a flat `Never answered`. A counter ticking up from three weeks ago is
noise pretending to be urgency.

A message that asked nothing and got no reply shows **no state line at all** —
`!looksLikeQuestion(body) && !reply`. Most agent mail is a done report; nobody
was asked for anything, so `Never answered` reads as a reproach and
`Awaiting your reply` names a wait nobody is in. The expand affordance and the
body-size label stay. A report you replied to anyway still shows the reply.

**Liveness — fact, best-effort.** `useSessionInventoryOptional()` returns
`ActiveSessionInfo[]`, each already carrying `agentName` and `agentStatus`.
Build `Map<agentName, agentStatus>` and look up `sender`. Amber pulse for a
running status, green for idle. No provider, no match, or an ambiguous match
across two teams means **no dot** — silence beats a grey "unknown" on every
card. No server work.

**Intent — the only guess, and gated.** `looksLikeQuestion(body)` fires on a
lead-phrase in the first 200 chars (`blocking question`, `before I touch`,
`should I`, `tell me one of`, `your call`, `who owns`, `confirm whether`), or on
the **closing line** — its last 200 chars, URLs removed — carrying a `?` or a
request put to the reader in imperative position (`…, tell me`, `…, say so`).
Questions land at the end or get announced up front.

Scope is the closing *line*, not the last quarter of the body: a quarter of a
long report reaches back far enough to catch a question the report itself quoted
and then answered. The imperative-position rule is what separates
"If you'd rather not, say so" from "the types say so", and what keeps the
"Let me know if you want…" sign-off — an offer, not a request — unflagged.
On the four real peer messages in `…honest-cms/ddb6fc34….jsonl` this is 2/2 on
the messages that ask and 0/2 false positives; without the request patterns it
was 1/2.

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
  the enqueue/attachment pair rendering once; pairing is forward-only; an
  unpaired message stays awaiting.
- **`agentEnvelope.test.ts`:** absorbs the existing `teammateMessage.test.ts`
  cases, covers both tag forms, malformed and unclosed tags, and
  `looksLikeQuestion` positives and negatives.
- **`AgentMessageCard.test.tsx`:** no raw tag in rendered output — fed a body
  that still holds an envelope, so the assertion can fail; subject and preview
  split correctly; awaiting vs replied vs no footer state; chip appears only
  when question *and* unanswered.
- `src/lib/__tests__/parser.test.ts:140` is a human prompt with no envelope, so
  it stays green unchanged.
- `bun run check:cogpit-memory-sync` after touching `shared/session/`.


## Latent issues found by mutation testing (not currently reachable)

Neither is pinned by a test, deliberately — pinning would cement one of two answers
before we know which is right.

**1. The enqueue ledger is keyed per `Turn` object.** `buildTurns` therefore cannot
reconcile a message's `queue-operation` and `attachment` copies if a turn boundary
falls between them. Should that happen, the same records render **2 cards on a full
parse and 1 when paged in** — the exact divergence `dedupeAgentMessages` exists to
prevent. Not reachable in observed data: in `ddb6fc34` both copies always land in the
same turn. If a duplicate ever reappears, look here first, and decide which count is
correct before writing the test.

**2. `origin.name` and `origin.from` are assumed identical.** The block's `sender`
resolves `name ?? from`, but reply pairing joins that sender against
`SendMessage.input.to`, which follows `from`. A record where the two differ would
render under `name` and never pair — the card would claim "Never answered" for a
message that was answered. Verified identical across all 7 real peer records on disk,
so this is an assumption worth re-checking if Claude Code changes the envelope, not a
present defect.

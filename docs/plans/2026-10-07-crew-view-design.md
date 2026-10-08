# Crew view: seeing and steering the sessions a coordinator runs

Status: phases 1 and 2 implemented 2026-10-07 (see 2026-10-07-orchestration-implementation.md)
Date: 2026-10-07
Mockup: `2026-10-07-crew-view-mockup.html` (open `#coordinator` and `#lane`);
renders in `docs/images/crew-view-coordinator.png` and `docs/images/crew-view-lane.png`

## Where this comes from

The workflow this designs for is already in daily use. Read back through
`cogpit-memory`, the clearest example is the Wave 3 coordinator
(`d43823ec`, Sonnet 5.5, 20 turns, 433 tool calls) in
`hcms-pr/performance-experiments` on 2026-10-06/07:

- It started 15 sessions with `cogpit-session new`, one per worktree
  (`~/hcms-pr/w3-*`), each on Opus 5.5 with a written brief. The agent
  calls them lanes.
- Each lane started its own read-only Codex reviewer (`--mode plan`) and sent
  it review rounds with `cogpit-session send` (`r1` through `r10` on the
  inventory lane). The tree is three levels deep.
- Finished lanes woke the coordinator with the durable
  `Delegated task … completed. Child session: … Result: {…}` prompt.
- Lanes merged PRs #236 through #252, closed ClickUp tickets through the
  coordinator, and wrote reports headed `Session X · coordinator Y`.

What went wrong, and what the user kept asking, is the brief:

| Evidence | What the UI has to do |
| --- | --- |
| "how many done so far?", "what has happened so far", "did we finish all we set to finish?" asked six times; each answer cost a coordinator turn and a ClickUp recount. | Answer "where are we?" at a glance, without a turn. |
| "make sure we are working and not waiting idle": two lanes had sat on permission prompts for hours after a restart reset their permission mode. Nobody noticed. | Make a blocked lane loud, show how long it has been blocked, and let the user answer it in place. |
| The coordinator wrote `babysit.sh` (Monitor, 45 s poll, 8 sessions). It died on bash 3.2 `declare -A` and 30 minutes of silence meant nothing. It was rewritten in zsh, then as a Python auto-approver with hold rules. | Cogpit should be the watcher. The server already polls delegated tasks every second. |
| "give me ask user question tool call for each question … I will do them one by one", then "ask me again the ui Bugged" when 15 questions fired at once. | A queue: one request at a time, answer, advance, with a count. |
| 4 lanes stopped on the weekly usage limit; the coordinator resumed them by hand. Load went from 8 to 22 when 5 lanes launched, and an overloaded machine had killed a CI run earlier. | Show paused lanes and machine capacity next to the tree. |
| In cv-builder: "why are you starting sonnet sessions? close them and do the work here". A child had started its own workers. | Show model and effort on every node, and let the user stop a subtree. |
| The coordinator's timeline today (seen in the app on 2026-10-07): turn headers read `Delegated task 931029a1-… completed. Child session: 9c1d4e1a-…`, two results sit in the message queue as `unknown` and `queued`, and the sidebar shows the 15 lanes scattered through "Today" with nothing tying them to their coordinator. A lane's view shows `Coordinator: …` as an ordinary user prompt and never names its parent. | Names, never ids. Lineage visible from both ends. |

## The idea

The coordinator is a manager and the user is the manager's manager. Cogpit is a
chat app with a flat list of chats; what is missing is the org chart and the
status board of that team, kept open beside the chat.

One data model, three surfaces:

1. **The Crew panel**, a right-rail workspace panel that appears on the
   coordinator and on every session in its crew. It is a map you keep open
   while you hop between the crew's sessions: the root stays pinned.
2. **The sidebar folds a crew under its coordinator**, the way agent-team
   members already fold under their lead.
3. **Inside a crew session**, the parent is named in the masthead, messages
   from the coordinator look like messages from the coordinator, and a lane
   finishing reads as "w3-perf-ship finished", not as a task id.

"Crew" is the proposed name: short, plain, aviation like the product, and
unused in the codebase. The agent's own word for a first-level child is
"lane"; the UI calls them sessions and uses their names.

## Surface 1: the Crew panel

A `WorkspacePanelDefinition` (`src/plugin-api/workspacePanels.ts`) with
`when` = the open session has a crew (it is a root with children, or it has a
parent), `badge` = sessions blocked on a human plus results the coordinator
has not read, and an `indicator` dot while any crew member is working.
Default width about 400 px; it can expand over the timeline.

```
┌ Crew ─────────────────────────────────────────── ⤢ ✕ ┐
│ Wave 3 coordinator                     15 sessions   │
│ ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮                                      │  formation strip
│ ● 2 working  ● 2 need you  ● 11 done                 │
├──────────────────────────────────────────────────────┤
│ Needs you                              1 of 2  ‹ ›   │
│ ┌──────────────────────────────────────────────────┐ │
│ │ w3-rooftop · waiting 42 min                       │ │
│ │ Bash  gh api repos/HonestCMS/cms/rulesets -X POST │ │
│ │ [Allow] [Always allow] [Deny]            Open ›   │ │
│ └──────────────────────────────────────────────────┘ │
│ Next: w3-security-admin asked a question             │
├──────────────────────────────────────────────────────┤
│ Sessions            All · Working · Need you · Done  │
│ ● w3-storefront-quality   Opus 5.5 · 11 turns   now  │
│     Running tests · PR #244 merged                   │
│   └ ○ Code review r10 · Codex · approved        8m   │
│ ● w3-inventory-pricing …                             │
│ ● w3-rooftop   permission · waiting 42 min           │
│ ○ w3-theories  finished · result waiting        1h   │
│ ○ w3-perf-ship PR #249 merged                   2h   │
│ …                                                    │
├──────────────────────────────────────────────────────┤
│ Activity                                             │
│ 16:42  w3-rooftop asked permission · Bash gh api …   │
│ 16:31  w3-cost-model finished · PR #251 merged       │
│ 14:35  w3-theories started · Opus 5.5 · xhigh        │
│ 13:10  6 sessions started                            │
├──────────────────────────────────────────────────────┤
│ Load 8.2 · 11 agent processes · 2.7M output tokens   │
└──────────────────────────────────────────────────────┘
```

### Formation strip

One cell per crew member in start order, colored by state: working (success,
with the halo the sidebar dot uses), needs you (warning), done (muted),
failed or stopped (destructive). The open session's cell carries a ring.
Hover names the session; click scrolls its row into view. Fifteen cells read
as a shape, which is the answer to "where are we?" before any number is read.
This replaces stat tiles.

### Needs you

Everything in the crew blocked on a human, as one card at a time with a
counter, newest last. The card reuses `PermissionPrompt`, `QuestionPrompt` and
the plan alert that `DelegatedRequests.tsx` already composes. Answering
advances to the next; Enter allows, Backspace denies, the arrows skip. "Open"
goes to the session with the panel still showing the crew. The card shows how
long the session has waited; past ten minutes the time turns warning.

Results the coordinator has not read (delegated tasks without
`acknowledgedAt`) count here too, as a plain sentence under the card: "2
results are waiting for the coordinator: w3-theories, w3-parity-soak" with
"Deliver now" (resume the coordinator so the wakeups go through) and "Mark
read". This is the current message queue's `queued` / `unknown` rows in
words.

### Sessions

The tree in start order, filterable by state. Rows are two lines:

- name (custom name, else the worktree folder when it differs from the root's
  cwd, else the AI title), then provider mark, model and effort, turn count,
  files changed, and time since activity in tabular numerals;
- what it is doing now (the current tool or the first line of its last reply),
  plus pull-request chips from the existing PR index with merged or CI state.

Children nest under the row with the same `border-l` rail the sidebar uses for
teammates, collapsed by default to a count when a row has more than two.
Hover actions: Open, Approve (when blocked), Stop, Stop with its children.
Stopping asks once and names what it stops.

Rows carry a device chip when the session runs on another machine, and a
"read-only" chip for plan-mode reviewers.

### Activity

A single feed across the crew, newest first, built from what the server
already records: session starts (origins `createdAt`, with model and effort),
delegated task state changes and acknowledgements, pending inputs appearing
and being answered (and by whom: the user, the coordinator, or a watcher),
turn completions, PR events from the PR index, usage-limit pauses and resumes,
and stops. Each line names the session as its subject and opens it on click.
This is "what happened while I was away" in one place.

### Footer

Machine load and the count of agent processes (the Perf panel's data), summed
output tokens for the crew, and the usage-limit state when one is active.

### Expanded mode

The panel widens over the timeline: the tree on the left, the selected
session's own timeline on the right, read-only with its composer. This is the
wall view for an 11-lane afternoon. Phase 4.

## Surface 2: the session browser

Mockup: `2026-10-07-crew-view-sidebar.html`, render in
`docs/images/crew-view-sidebar.png`.

One rule: **the browser lists roots, and a session started by another session
lives under the session that started it.** A root is a session no visible
session started: one you began from the composer, one resumed, one started
from a terminal with `cogpit-session` outside any session, or a duplicate.
Everything `cogpit-session new` or `create-and-send` created with a
`parentSessionId` is a member of its parent's crew.

Roots stay cards; members are rows. That is the idiom the browser already
uses for agent-team members under their lead, so nothing new has to be
learned, and the two kinds of session look different at a glance.

### The root card

- **Sorted and shelved by crew activity.** The card's time, its shelf (Today,
  Yesterday) and its position use the latest activity of the root or any
  member. A coordinator idle for an hour while its lanes work stays at the top
  of Today, and its time reads "crew active now".
- **The dot is the crew's.** Warning if any member is waiting on someone,
  working if any member is working, else the root's own state. The root's own
  status badge ("Done", "Thinking") stays about the root.
- **A crew line** closes the card: `⌄ Crew · 15 · 2 need you · 2 working`.
  Counts that need someone are in warning color. Collapsed by default;
  expanded state is remembered per root.
- **Expanded**, members list by state: need you, working, paused or failed,
  then done folded into "+11 done" with a show link. Each row: dot, name,
  state and time. A member with its own children says "· 2 reviewers" on its
  row. The sidebar stays two levels deep; the Crew panel shows the whole tree.
- **Member names:** custom name, else the worktree folder when it differs from
  the root's folder, else the AI title. Rows show no project eyebrow; the
  root's project is the crew's.
- **The menu** on a root offers "Archive crew (16 sessions)" and "Stop crew"
  beside the usual actions. Auto-archive treats a crew as one: members leave
  with their root, and a member's activity unarchives the root.

### When the root is not in the list

A member whose root is out of view (another project scope, archived, a search
that matched only the member, or a root on another device) appears as a card
with a **lineage eyebrow** in place of the project eyebrow:
"↑ Wave 3 coordinator · performance-experiments". Clicking it opens the root.
A member is never lost and never looks like a root.

### Scope, search and the strip

- The project scope picker counts crews: "performance-experiments · 1 session ·
  1 crew of 15". A crew whose members sit in other folders (worktrees, other
  projects) is scoped by its root; the members come along under it.
- Search is flat: every match is a card, members carry the lineage eyebrow.
- The "Needs you" and "Working" strips at the top of the sidebar list roots
  only, so fifteen lanes cost one row. A root whose crew has members waiting
  shows one row with a "2 waiting" chip and the longest wait; a root whose
  members are working shows "2 in crew". A root is in one group: "Needs you" if
  it or any member waits on someone, else "Working" if any of them works.
  Clicking the row opens the root with the Crew panel's queue in front.
  Members never appear in the strips while their root is visible.
- A toolbar toggle, "Group spawned sessions", is on by default. Off gives the
  flat list with the lineage eyebrow on every member, for when you want to see
  everything by time.

### Paging

List rows carry a server-computed crew summary (`count`, `needsYou`,
`working`, `lastActivityAt`); members load when the fold opens. Because roots
sort by crew activity, a member is never newer than its root, so a page never
shows a member without its root. `activeSessionRow.ts` emits
`parentSessionId` (already filtered by `visibleLineage.ts`), and
`splitTeammates` in `sessionListView.ts` generalises to it.

### What is not a crew

A duplicated session is a root (branching is not delegation). Agent-team
members keep their fold under the lead. Claude's in-process subagents stay
inside their session's timeline.

## Surface 3: inside a crew session

- **Masthead.** A member session shows a pill after its own: "↑ Wave 3
  coordinator". Clicking it opens the root; the Crew panel stays as it was.
- **Messages from the coordinator.** A prompt that arrived through
  `cogpit-session send` from the parent renders as a "From Wave 3 coordinator
  · 14:02" card, not as a user prompt. The agent-mail design did this for
  teammate messages; the orchestration store knows the sender of a durable
  send, so the renderer does not have to parse a `Coordinator:` prefix.
- **A lane finishing.** `DelegatedResultCard` already shows the child's title;
  the sticky turn header and the queue still print the raw wakeup. Both use
  the parsed form: "w3-ops-tooling finished · PR #252 merged · 44 files".
- **Notifications** name the crew: "w3-rooftop (Wave 3 coordinator) needs a
  permission".

## Interaction rules

- **Pinned root.** Opening any crew member keeps the panel rooted at the crew's
  root, with "you are here" on the member's row. Leaving the crew (opening an
  unrelated session) swaps the panel to that session's crew or hides it.
- **Names, never ids.** Ids appear only in the hover preview, in mono.
- **One request at a time.** The queue is the only place that shows more than
  one pending request, and it shows one card.
- **Blocked time is a first-class number.** Every blocked row and card shows
  how long, and the activity feed records who unblocked it.
- **Stop is explicit about scope.** "Stop w3-rooftop" and "Stop w3-rooftop and
  its 1 reviewer" are two actions.
- **Motion only on state change.** A cell changing state fades once. Nothing
  pulses; `animate-pulse` is already disabled app-wide.

## Design language

The panel is native Cogpit: Geist, the neutral oklch greys, semantic color
only for state, hairline borders, 0.5 rem radius, 11 to 13 px text. The
boldness is spent in one place, the formation strip; everything else is
rows with hairlines.

- Color: `--card` for the panel, `--border` hairlines, `--success` working,
  `--warning` blocked, `--destructive` failed, `--muted-foreground` done.
  Tints at 10 % with 30 % borders, as the attention strip does.
- Type: Geist for everything; Geist Mono only for ids, SHAs and commands.
  Tabular numerals for counts and times, right-aligned.
- Layout: left-aligned, dense rows, children indented 16 px behind a rail.
- Not doing: a node-and-edge graph (worse than a tree for 15 flat lanes), a
  Kanban (ClickUp is the task board; sessions are not tasks), stat tiles,
  all-caps labels, decorative motion.

## Data: almost everything exists

| Element | Source today | Gap |
| --- | --- | --- |
| Tree | `~/.cogpit/session-origins.json` via `GET /api/session-children/:id` (`SessionState[]`: outcome, live, running, status, toolName, waiting, device, error) | Recursion (children of children) and the root of a given session. One `GET /api/session-crew/:id` that returns the root, the tree with per-node state, tasks and requests, so the panel polls one endpoint. |
| Row name, model, turns, files, last reply | `GET /api/session-result/:id`; `inventorySession()` for title and activity | `activeSessionRow.ts` should emit `parentSessionId` (`visibleLineage.ts` already filters it) so the sidebar can fold without extra requests. |
| Needs you | `GET /api/session-requests?parent=` (delegated requests) and `waiting[]` in session state; `POST /api/session-respond` | Requests from members whose questions go to the coordinator (`--questions agent`, the default) are not in `session-requests`; the crew endpoint lists them from `waiting[]` so the user can still answer. Blocked-since time: `PendingInput` has no `askedAt` for permissions; add it. |
| Unread results | `GET /api/delegated-tasks?sessionId=` (`acknowledgedAt`, `deliveryDisposition`, `wakeupCommandId`) | None. |
| PR chips | PR index on `ActiveSessionInfo.pullRequests` | None. |
| Activity | origins `createdAt`, task updates, notifications, PR index, `rate_limit_event` blocks, orchestration `events` (type `task`, `question`, `command`) | A crew event log the server writes as these happen (small, per root), rather than reconstructing from six sources on every poll. |
| Capacity | `GET /api/running-processes`, Perf panel load | Token sum per crew: `usageCost/service.ts` already walks subagents by parent; extend to delegated children. |
| Sender of a prompt | orchestration store command receipts | Mark commands sent by a session (CLI `callerSessionId`) so the timeline can render "From Wave 3 coordinator". |

Live updates: the panel polls its one endpoint every 3 s while visible, as the
existing strips do, until the stream bus carries crew events.

## Phases

1. **Lineage everywhere.** `parentSessionId` on list rows; sidebar fold;
   masthead "↑ parent" pill; wakeup turn headers and queue rows use the parsed
   name; notifications name the crew. Small, and it fixes today's screenshots.
2. **The Crew panel.** `/api/session-crew/:id`; the panel with formation
   strip, needs-you queue (reusing the prompt components), the sessions tree
   with open, approve, stop; unread results in words. Replace the
   `DelegatedSessions` strip above the composer with a one-line summary that
   opens the panel.
3. **Activity and capacity.** The crew event log, the feed, PR events, the
   footer, "From coordinator" cards.
4. **Supervision and the wall.** A per-crew setting that does what
   `babysit.sh` did: after N minutes blocked, wake the coordinator with the
   request; optionally approve commands inside the member's own worktree and
   hold anything else for the user. "Add session" from the panel, prefilled
   with the root's cwd and recorded as its child. Expanded split view.

## Open questions

- The name: Crew, or something else. Everything above reads the same with
  another word.
- Should Claude's in-process subagents (the Agent tool) appear in the tree as
  leaves under their session? They have their own panel today; showing them
  here would make the picture complete but doubles the row count.
- Should supervision policy (auto-approve inside a worktree) live in Cogpit at
  all, or stay the coordinator's job with Cogpit only doing the "blocked for N
  minutes" wakeup?

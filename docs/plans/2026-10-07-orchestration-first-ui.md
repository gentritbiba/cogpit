# Cogpit, orchestration first

Status: in progress; phases 0 to 2 implemented 2026-10-07 (see 2026-10-07-orchestration-implementation.md)
Date: 2026-10-07
Builds on: `2026-10-07-crew-view-design.md` (the Crew panel and the session
browser). Mockups: `2026-10-07-orchestration-first-ui-mockup.html`
(`#home`, `#wall`, `#mobile`); renders in `docs/images/orchestration-first-*.png`.

## The thesis

Cogpit was built as a browser of agent sessions: a list of chats, one open at
a time, with panels around it. The way work actually happens now is
different. You talk to one agent, it starts a crew, the crew does the work,
and you make decisions. In the Wave 3 session the human wrote twenty
messages while fifteen sessions ran, merged seventeen pull requests and
asked for about twenty decisions.

That flips what the interface is for:

| Session-first (today) | Orchestration-first |
| --- | --- |
| The unit is a session. | The unit is a session you talk to, plus its crew. |
| Home is a list of projects; today the fifteen lanes appear as fifteen projects. | Home is the supervisor's desk: what needs me, what is moving, what landed. |
| Attention is a sidebar strip and a bell. | Attention is a queue you work through with the keyboard, across every crew and device. |
| The transcript is the product. | The transcript is one of three surfaces: the conversation, the crew, and the wall. |
| Delegation is invisible: `cogpit-session` calls are Bash cards and results are raw text. | Delegation is a first-class thing you can see, approve, budget and stop. |
| A device is a mode of the whole app. | A device is an attribute of a session. |

Nothing in the visual language changes. Geist, neutral greys, color only for
state, dense rows, the floating pills. The principle from the simplification
plan still governs: a pixel earns its place only if it changes what you would
do next. The formation strip, one cell per crew member, becomes the mark that
appears wherever a crew is summarised.

## Vocabulary

Three words, two of them already in use.

- **Your sessions**: the ones you talk to. Anything you start from the
  composer, resume, duplicate, or launch from a terminal.
- **Crew**: the sessions a session started through `cogpit-session`, and
  theirs. A session with no crew is just a session; nobody has to think about
  the difference until a crew exists.
- **Mission Control**: home. It already exists as the name of the
  "every live session" grid; it becomes the whole first screen.

No "mission" noun. A crew belongs to the lead's durable conversation id (the
orchestration store's `conversations` table), not to a native session id, so
a provider handoff or restart of the lead keeps its crew.

## The four surfaces

### 1. Mission Control, the home

The first screen, and what the bell opens. It replaces the Projects home and
the current Mission Control grid. The session sidebar is closed here, because
the home is the list.

```
┌ Mission Control ───────────────────────────── 🔔 4   2 devices   ⋯ ┐
│                                                                     │
│ Needs you  4                 │ Your sessions  3                     │
│ ┌─────────────────────────┐  │ ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ Wave 3 coordinator    │
│ │ w3-rooftop · Wave 3     │  │   2 working · 2 need you · 11 done   │
│ │ permission · 42 min     │  │   PR #252 merged · 2h                │
│ │ Bash gh api …           │  │ ▮▮ Job applications                  │
│ │ [Allow][Always][Deny]   │  │   2 working · Runway confirmed · 3m  │
│ └─────────────────────────┘  │ ▮ Rethink Cogpit's UI                │
│ 2 w3-security-admin · quest. │   working · now                      │
│ 3 Wave 3 wants 2 sessions    ├──────────────────────────────────────┤
│ 4 find-20-jobs · plan        │ Landed today                         │
│                              │ 16:31 PR #251 merged · w3-cost-model │
│                              │ 15:50 PR #252 merged · w3-ops-tooling│
│                              │ 13:40 4 sessions resumed after limit │
├──────────────────────────────┴──────────────────────────────────────┤
│ Mac load 8.2 · 11 agents · agentbox idle · limit resets 18:00       │
│ ┌ What should we build? ─────────────── performance-experiments ⌄ ┐ │
└─────────────────────────────────────────────────────────────────────┘
```

- **Needs you** is a queue, not a grid. It is the one place that itemises
  every request; the sidebar's strip rolls a crew up into its root's row so
  the sidebar never fills with members. One card has focus and is answerable
  in place with the components the session view already uses; the rest are a
  numbered list under it. Every card names the session and the lead it
  reports to, and how long it has waited. Kinds: permission, question, plan,
  launch review (below), and "results waiting for a lead that is not
  running". Keys: J and K move, Enter takes the first action, D denies, O
  opens the session, N skips.
- **Your sessions** are roots, sorted by crew activity, each with its
  formation strip, state counts, the last thing that landed and a device chip
  when any member runs elsewhere. Click opens the session; the strip's cells
  open members. This is the sidebar list with room to breathe, and the one
  list model the sidebar, the home and ⌘K all share.
- **Landed today** is the activity feed across every crew: pull requests
  merged, sessions finished, results delivered, decisions you made, usage
  limits hit and cleared. Grouped by time, each line opens its session.
- **Capacity** is one line per device: load, agent processes, usage-limit
  state, tokens today. It renders nothing when everything is normal, and
  comes back on threshold, as the simplification plan requires.
- **The composer** starts a session. It is the only way to start work and it
  looks like every other composer: project switcher, model, effort. "What
  should we build?" stays.

Projects do not disappear: the scope picker filters home and sidebar by
project, and the project settings keep their page. They stop being the home.

### 2. The session, with its crew

The session view keeps its shape: sidebar, conversation, right rail. Three
things change.

- **The crew panel** (designed in the Crew view doc) is open by default when a
  crew exists, pinned to the lead while you move between members.
- **Delegation renders as what it is.** A `cogpit-session` call in the lead's
  transcript is not a Bash card. `new` renders "Started w3-perf-ship · Opus
  5.5 · worktree" with the brief folded under it, several in one turn render
  "Started 6 sessions" with a mini formation strip, `send` renders "Messaged
  w3-rooftop: …", `wait` renders "Waited on 3 sessions · 2 finished · 1
  needs input", `approve` renders "Approved w3-rooftop's permission", `stop`
  renders "Stopped w3-theories". A finished member's result arrives as
  "w3-ops-tooling finished · PR #252 merged · 44 files", never as a task id.
  The lead's transcript reads as a manager's log.
- **Opening a member** puts "Wave 3 coordinator › w3-rooftop" in the session
  pill. The composer is labelled "Message w3-rooftop directly" with the note
  that the lead sees it in the activity feed. Escape returns to the lead.

### 3. The wall

For the afternoon with eleven lanes. From the crew panel's expand button or
⌘⇧W, the conversation column becomes a grid of live tiles, one per member
that is working or blocked, three across. A tile shows the member's name,
state and time, the last lines of its output streaming (the machinery
`LiveSubagentTranscript` already has), its pull request chip, and, when it
is blocked, the request with its buttons. Done members fold into a row at
the bottom. Click a tile to open the member; Escape returns to the wall. The
crew panel stays beside it.

### 4. Delegation you can see, approve, budget and stop

- **Launch review.** When the lead runs with permissions supervised, starting
  a session is a permission like any tool: "Wave 3 coordinator wants to start
  2 sessions: w3-ruleset-apply (Opus 5.5, worktree), w3-g08-verify (Codex,
  read-only)". Allow one, allow all, change the model, or deny. A lead running
  with permissions bypassed starts sessions without asking, as today. This is
  where "why are you starting Sonnet sessions?" is caught before it happens.
- **Crew budget** per session, set in the session's menu and shown in the
  crew panel header as "6 of 8 slots": the most members that may run at
  once, whether members may start their own crews, and a token cap. Over the
  budget, `cogpit-session new` returns a refusal the lead can relay instead
  of silently loading the machine to 22.
- **Supervision.** A member blocked for N minutes wakes the lead with the
  request, through the delegated-task monitor that already polls every
  second. Optionally the lead may answer routine prompts inside the member's
  own worktree and hold everything else for you. Both are per-session
  settings, both off by default, and both replace the watcher scripts the
  coordinator kept writing.
- **Questions routing** is already a flag; the queue shows who a request is
  addressed to and lets you take one addressed to the lead.
- **Stop** is scoped and says so: a member, a member and its reviewers, or
  the whole crew.

## Devices become an attribute

Today the app runs against one device at a time and remounts on switch. A
crew spans machines by design (`new --device agentbox` exists), so the
home, the sidebar and the crew panel merge sessions from every registered
device. A device chip sits on rows and tiles; the device switcher becomes a
filter in the scope picker ("All devices", this Mac, agentbox); capacity
reads per device; opening a remote session routes through `/d/:id` as now.
The hub already answers per device; the list and crew endpoints aggregate.
This is the largest plumbing change and comes last.

## Notifications

The bell is the queue count and opens the queue. Desktop and ntfy
notifications name the member and its lead ("w3-rooftop, Wave 3 coordinator:
needs a permission") and carry an Allow action where the channel supports
one. A finished member does not notify; that is the lead's job. Two results
waiting for a lead that is not running does.

## Mobile

Mobile is where the queue pays for itself: approving from the phone. The
three tabs become Now, Chat and Crew. Now is the queue card at the top and
your sessions below it with formation strips; Chat is the open session; Crew
is the crew panel as a sheet. The iOS app consumes the same endpoints.

## Keyboard

`⌘K` acts on Cogpit, `/` acts on the agent, as before. New: `⌘1`–`⌘9` jump to
your sessions in home order (device switching moves to `⌘K`); on the home,
J, K, Enter, D, O and N work the queue; in a session with a crew, `⌘⇧W`
opens the wall, `⌘[` returns to the lead, `⌘]` goes to the next member that
needs you.

## What goes away

- The Projects home and the Dashboard's project and session views; the
  scope picker and ⌘K cover browsing.
- The Mission Control grid of session cards; its "answer in place" idea
  becomes the queue, its grid becomes the wall.
- The delegated-sessions strip above the composer; the crew panel owns it.
- Raw wakeup text in turn headers and the message queue.
- The device switcher as an app mode.
- Six parallel "which session" lists, replaced by one list model.

The terminal drawer, settings, plugins and workspace panels stay as they are.

## Data and plumbing

| Need | Have | Add |
| --- | --- | --- |
| Roots with crew summaries | `session-origins.json`, `/api/active-sessions` | `parentSessionId` and a `crew` summary on list rows; roots sorted by crew activity |
| Crew tree with state | `/api/session-children/:id`, `/api/delegated-tasks`, `/api/session-requests` | `/api/session-crew/:id`: root, recursive members with state, tasks, requests |
| Queue across everything | `/api/permissions`, `/api/user-questions`, `/api/agent-prompts`, delegated requests, `waiting[]` | `/api/attention`: every pending request with lineage, device and `askedAt`; `askedAt` on permission prompts |
| Delegation cards in the transcript | Bash tool calls | A renderer keyed on the `cogpit-session` command; the orchestration store marks commands sent by a session |
| Launch review | permission prompts | `cogpit-session new` asks the lead's runtime for permission when the lead is supervised |
| Crew budget | nothing | per-session limits in session config; the CLI enforces and reports |
| Supervision | delegated-task monitor (1 s) | blocked-for-N wakeup; optional routine-approval policy |
| Activity feed | origins, tasks, notifications, PR index, orchestration events | a crew event log written as events happen |
| Wall tiles | `LiveSubagentTranscript`, stream bus | subscribe to several sessions' tails at once |
| Devices merged | hub per-device proxy | aggregation in the list, crew and attention endpoints; device on every row |

## Phases

0. **Lineage everywhere.** List rows carry the parent; the sidebar folds;
   wakeups and queue rows are named; notifications name the lead. Days.
1. **Crew panel and the manager's log.** `/api/session-crew`, the panel, the
   `cogpit-session` renderer. About a week.
2. **Mission Control as home.** The queue, your sessions, landed, capacity,
   the composer; one list model for sidebar, home and ⌘K; the Projects home
   and the old grid retire. One to two weeks.
3. **Governed delegation.** Launch review, crew budget, supervision,
   notification actions. About a week.
4. **The wall and mobile Now.** About a week.
5. **Devices as an attribute.** Aggregated endpoints and merged lists. Last,
   and the largest.

## Decisions for you

- Launch review default: on for supervised leads (my recommendation), or
  always off until you turn it on.
- Whether a lead may answer routine prompts in a member's worktree
  automatically, or whether Cogpit only wakes it and the lead decides.
- Home as the first screen for everyone, or only once a crew exists (the
  simpler first launch is the same composer either way).
- `⌘1`–`⌘9` for sessions instead of devices.

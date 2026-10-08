# Orchestration-first Cogpit: implementation

Status: phases 0–3 implemented and tested (2026-10-08)
Started: 2026-10-07
Designs: `2026-10-07-crew-view-design.md`, `2026-10-07-orchestration-first-ui.md`,
`2026-10-07-coordinator-components.md`

The working tree already holds the uncommitted durable-orchestration work of
2026-10-03 (orchestration store, delegated tasks, `DelegatedSessions`,
`ConversationQueue`). This plan builds on it and does not change it except
where a step says so.

Baseline before any change (2026-10-07): all four typechecks clean; Vitest
9,052 passed, 5 failed, all timeouts under full-suite load
(`workspaceTransfer/handoff` ×2, `copilotTransport` abort, `appLoading` edition
retry, `ConversationHandoffMenu` mobile).

## Data contract

A crew is the sessions one session started through `cogpit-session` (recorded
in `session-origins.json` as `parentSessionId`), and theirs. The root is the
first session in that chain nothing started.

`/api/active-sessions` rows gain:

```ts
crew?: {            // on a member
  rootId: string
  parentId: string
  startedAt: number // origin createdAt, for start order
  name?: string     // the --name it was started with
  rootTitle?: string    // only when the root is not in the response
  parentTitle?: string  // only when the parent is not in the response
}
crewSummary?: {     // on a root that has members in the response
  size: number
  activityAt: string // latest activity of the root or any member
}
customTitle?: string // the transcript's custom title (Claude --name)
```

Paging folds before it limits. Unless the request is a search, a member whose
root is listed with it (a visible, unarchived candidate) is not a unit of its
own: the root's recency is the crew's, the root takes one slot under the
per-project and total caps, and every visible member is appended after the
units. A member whose root is not listed is a unit and carries the titles for
its lineage eyebrow. A project filter applies to units; members follow their
root.

## Phase 0: lineage everywhere

Server
- [x] `sessionOrigins`: record `name`; `sessionParents()` snapshot.
- [x] `server/lib/crew.ts`: pure `crewRoot`, `foldCrews` (units, members by
      root, crew recency), cycle and depth safe. Tests.
- [x] `activeSessionsRoute`: fold before the pool, sort units by crew recency,
      append members, project filter on units. Tests.
- [x] `activeSessionRow`: `customTitle`, `crew`, `crewSummary`.
- [x] `visibleLineage`: drop `crew` when its root or parent is hidden.
- [x] CLI `new` and `create-and-send` record the name.

Client
- [x] `ActiveSessionInfo` fields; `sessionTitle` uses `customTitle`.
- [x] `src/components/LiveSessions/crew.ts`: index, member state, roll-up,
      member display name. Tests.
- [x] `SessionCardList`: fold members under roots, order roots by crew
      recency, orphans keep a lineage eyebrow; "Group spawned sessions"
      toggle, on by default.
- [x] `SessionCard`: crew line with disclosure, member rows by state, "+N
      done", remembered per root; lineage eyebrow.
- [x] `AttentionStrip`: roots only; "N waiting" / "N in crew" roll-up.
- [x] Project scope: options and counts from units; members follow their root.
- [x] Session pill: "Reports to <parent>" for members.
- [x] Wakeups named in the sticky turn header and the delivery-problem queue.
- [x] Notifications name the crew.

Verified 2026-10-07 on a standalone build (port 19387, copied origins) against
the real Wave 3 crew: the coordinator lists once with 24 members, sorted by
crew activity; the strip shows it as one row; project scope brings the crew
along; search lists matches flat with lineage; a lane shows "Reports to".
Found and fixed on the way: list rows dropped `customTitle`, so `--name`d
lanes showed their brief; reviewers started through `create-and-send` without
`parentSessionId` have no lineage (the cogpit-sessions and code-review skills
now pass `$COGPIT_SESSION_ID`).

## Phase 1: Crew panel and the manager's log

- [x] `GET /api/session-crew/:id`: root resolution, recursive members across
      hosts with state, delegated tasks, pending requests with lineage.
- [x] Crew workspace panel: formation strip, needs-you queue, sessions tree,
      footer; pinned to the root; badge and indicator.
- [x] `cogpit-session` tool calls render as delegation cards.
- [x] `DelegatedSessions` strip becomes a one-line summary that opens the panel.

## Phase 2: coordinator components

- [x] `cogpit status`, `cogpit decisions`, `cogpit checklist` fenced blocks.
- [x] "Showing structure" section in the `cogpit` skill sources; sync.
- [x] Board: `cogpit-session board`, store, pinned row, panel header.

## Phase 3: Mission Control home

- [x] Queue from the shared pending-input context: permissions, questions, elicitations, dialogs, plans and deferred permissions, with lineage and request timestamps. Existing authenticated endpoints supply it; no duplicate attention poll.
- [x] Home: oldest-first queue, crew roots, today’s PRs/finished members/starts, running-agent count, and project picker leading to the existing composer. Project history stays available through All projects; mobile Workspace uses the same home.

## Later phases

Governed delegation (launch review, crew budget, supervision), the wall, mobile
Now, devices as an attribute. See the orchestration-first doc.

## Continuation verification

Recovered from session `9dbcab27-5326-45b2-aa67-ed39093c6cf6` on 2026-10-08.
All seven first-review findings were fixed, including decision identities per
turn and block occurrence, remote task-based panel availability, filtered crew
recency, shell command-position scanning and notification visibility.
Crew actions guard duplicate sends and reject stale completions after navigation.
The replaced client Mission Control grid and its private hook/view helpers were
removed; prompt controls now live in `src/components/pending-input/`.

## Verification per phase

`bun run test`, `bun run test:public`, typechecks, lint, `check:agents`,
`check:architecture`, browser QA on a standalone build with a synthetic crew,
React Doctor for UI, and an independent Codex review before calling a phase
done.

Release validation on 2026-10-08: 10,918 tests passed with the edition package;
9,170 passed in public mode; memory package 109 passed on Bun 1.3.14. Production
and test typechecks, protocol drift, architecture and agent containment passed.
The npm launcher and memory package contracts passed. Browser QA verified the
new home, project history and a real 24-member crew with automatic panel opening.
The independent release review found twelve issues across the prior core work and
UI; fixes cover parsed-target authorization, npm dependency declaration, distinct
queued completion receipts, remote answers/navigation, scoped decision state and
links, duplicate IDs, shell escapes and instance notification routing.

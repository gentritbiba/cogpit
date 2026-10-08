# Components the coordinator can show

Status: tiers 1 to 3 implemented 2026-10-07 (see the implementation plan)
Date: 2026-10-07
Part of: `2026-10-07-orchestration-first-ui.md`
Mockup: `2026-10-07-coordinator-components-mockup.html`; render in
`docs/images/coordinator-components.png`

## The question

A coordinator reports constantly: "34 of 99 tickets", "decisions I need from
you: 1 to 4", lane tables, what shipped, what is blocked. Today all of it is
prose and markdown tables, and the one structured tool it has, asking
questions, broke when it fired fifteen at once. Can the coordinator show real
interface components instead, and how realistic is that?

Realistic, in three tiers. Each is a different amount of trust in the agent,
and the first costs the agent nothing.

## Tier 1: derived, for free

Cogpit already knows what the coordinator did, because it did it through
`cogpit-session`. The timeline renders those calls as cards without the agent
saying anything:

- "Started 6 sessions" with a formation strip and the six names, folding the
  briefs under it.
- "Messaged w3-rooftop: rebase onto main and send r3".
- "Waited on 3 sessions: 2 finished, 1 needs input".
- "Approved w3-rooftop's permission", "Stopped w3-theories".
- "w3-ops-tooling finished: PR #252 merged, 44 files" for the result wakeup.

The crew panel, the home and the activity feed are the same idea at a larger
scale. This tier is phase 1 of the orchestration plan and needs no skill;
the renderer keys on the command.

## Tier 2: declared blocks, taught by a skill

For what Cogpit cannot derive, the coordinator declares a component in a
fenced block. The timeline already routes every fenced block through
`MarkdownCodeBlock` by language tag, so the tags `cogpit-status`,
`cogpit-decisions` and `cogpit-checklist` are the hook (a hyphenated tag,
because the markdown renderer passes only the first word of an info
string). The body is YAML, or JSON. A block that does not parse renders as
the code it is, so a wrong guess costs nothing. Blocks render only in the
assistant's final text; a prompt that quotes one shows code. Three kinds cover what the Wave 3 session actually
wrote.

### `cogpit-status`

A progress summary. One bar, a few labelled values, no big-number tiles.

````markdown
```cogpit-status
title: Wave 3 · 99 tickets
progress: { done: 35, total: 99 }
values:
  - { label: Merged today, value: 7 pull requests }
  - { label: Built, waiting to merge, value: 12 tickets }
  - { label: Blocked on you, value: 4, tone: warning }
  - { label: Blocked on others, value: 9 }
```
````

### `cogpit-decisions`

The fix for fifteen questions at once. The coordinator lists the decisions it
needs in one block; the user answers them one at a time, with the keyboard,
in any order; the block collects the answers and sends them as one message
("Decisions: sharp approve, sentry later, status page approve") when the user
presses Send or when every decision has an answer. Unanswered decisions also
appear in the Needs-you queue, so they are not lost when the message scrolls
away.

````markdown
```cogpit-decisions
- id: sharp
  question: Bump sharp to 0.34 through its own PR?
  options: [Approve, Later, No]
  detail: Separate worktree, merges when CI is green, then I confirm the production deploy.
- id: sentry
  question: Run sentry-cli login yourself today?
  options: [Now, Later]
  detail: G09.2, G10.2 and G13.1 stay open until it is done.
- id: status-page
  question: Deploy the status page Worker?
  options: [Approve, Hold]
```
````

A decision may carry `recommended: Approve`; the UI marks it and Enter picks
it.

### `cogpit-checklist`

A plan with states, for "here is what happens next" and for progress inside a
lane.

````markdown
```cogpit-checklist
title: Shipping w3-rooftop
items:
  - { text: Fix the P1 and both P2 findings, state: done }
  - { text: Rebase onto main c86033b1, state: done }
  - { text: Codex review round 3, state: doing }
  - { text: Apply the ruleset (needs your permission), state: blocked }
  - { text: Open the PR and merge when green, state: todo }
```
````

States: `todo`, `doing`, `done`, `blocked`, `skipped`. Blocked items in a
lane's checklist also show on that lane's row in the crew panel.

### What is deliberately not a block

Tables (markdown tables already render), images and videos (already inline),
questions with a single answer (the question tool already is a component),
and charts (a `cogpit-status` bar is the one chart a coordinator needs).

### The skill

A "Showing structure" section in the existing `cogpit` skill bundle
(`.claude/skills/cogpit/SKILL.md`, synced by `sync-cogpit-skill`), one page:
the three blocks, one example each, and the rules: use `status` for counts you
would otherwise write as a sentence, `decisions` whenever you need more than
one answer, `checklist` for any plan you are about to execute. The skill ships
in the same release as the renderer; published earlier, agents would emit
blocks that show as code.

## Tier 3: the board, through `cogpit-session`

A long mission needs one place that is always current, outside the scroll.
The session goal is the precedent: a per-session value shown as a row above
the composer. The board is that, with structure, and the coordinator updates
it with the CLI instead of writing a message:

```bash
cogpit-session board set --json '{"title":"Wave 3","progress":{"done":35,"total":99},"now":["storefront PR shipping","inventory rebasing"],"needsYou":["sentry-cli login","admin hostname"],"doneToday":["#251","#252"]}'
cogpit-session board update --done-add '#253' --now-remove 'storefront PR shipping'
```

- Stored in the orchestration store under the lead's conversation id, with
  history, so it survives restarts and provider handoffs.
- Shown pinned above the composer as one line ("35 of 99 · 7 merged today · 4
  need you · updated 2m ago by Wave 3 coordinator") that expands to the
  sections, and in the crew panel header.
- The user can edit it; the coordinator sees the edit as a short message.
- `cogpit-session board` prints it, so a lane or a fresh coordinator can read
  where the mission stands.

This is the most valuable of the three for the Wave 3 kind of mission, where
the human's recurring question was "how many done now?".

## Not doing: agent-authored interfaces

Letting the agent write HTML or React and rendering it in a sandboxed frame is
possible (local files already serve through `/api/local-file`, runtime plugins
already run in iframes). It is not worth it yet: the design system would not
reach into the frame, every block would look different, and the three tiers
above cover what coordinators actually write. Revisit if a real need appears
that a declared block cannot express.

## Effort

| Tier | Work | Size |
| --- | --- | --- |
| 1 | `cogpit-session` renderer in the timeline | in phase 1 of the orchestration plan |
| 2 | YAML parse, three components, fallback, queue integration for decisions, tests, skill section | about two days |
| 3 | `board` commands, store table, pinned row, crew panel header, edit from the UI | three to four days |

## Decisions for you

- Whether unanswered `decisions` should also enter the Needs-you queue (my
  recommendation) or stay only in the message.
- Whether the board is per session or per crew root only.
- Whether the user's edits to the board should message the coordinator
  immediately or wait for the next turn.

---
name: cogpit
description: Working inside Cogpit or against a Cogpit server. Recall and search earlier agent sessions with the cogpit-memory CLI, start, wait on and answer other sessions, on this machine or another one, with the cogpit-session CLI, show screenshots, recordings and diagrams inline in the Cogpit timeline, and show progress, decisions and plans as interface blocks instead of prose. Use when asked what happened in a past session, when you need to start or message another agent session or hand a task to another machine, whenever you have an image or video to show the user, and whenever you report progress, need several decisions from the user, or lay out a plan.
---

# Cogpit

Cogpit is a workspace for Claude Code, Codex and Copilot CLI sessions. This one
skill carries the three things an agent needs there. Read only the reference
that matches the job.

| Need | Read |
| --- | --- |
| Recall or search earlier sessions, drill into turns, tool calls and subagents | [references/cogpit-memory.md](references/cogpit-memory.md) |
| Delegate to other sessions, here or on another machine: start, message, wait on, answer or stop them with `cogpit-session` | [references/cogpit-sessions.md](references/cogpit-sessions.md) |
| Show a screenshot, recording or diagram to the user | "Showing images and videos" below |
| Report progress, ask for several decisions at once, or lay out a plan | "Showing structure" below |

Both references talk to the local Cogpit server. Resolve its port the same way
everywhere: `$COGPIT_PORT`, then `~/.cogpit/port`, then `19384`.

```bash
PORT="${COGPIT_PORT:-$(cat ~/.cogpit/port 2>/dev/null || echo 19384)}"
BASE="http://localhost:$PORT"
```

## Showing images and videos

Cogpit renders markdown image syntax inline in the timeline. The same syntax
covers images and videos; the file extension decides which one you get.

```markdown
![Checkout page after the fix](/tmp/checkout-after.png)
![Full checkout run](/tmp/checkout-run.webm)
```

- Images (`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `bmp`, `ico`, `avif`)
  open in a zoomable viewer when clicked.
- Videos (`mp4`, `m4v`, `webm`, `mov`) play inline with controls and seeking.
- Local paths must be absolute and live on the machine that runs the Cogpit
  server, which is the machine you run on. Cogpit serves them through its own
  proxy; the user does not need the file.
- Only local files render. The app's Content-Security-Policy blocks remote
  `https://` media, so download a remote file first and reference the path.
- A bare absolute path alone on a line also renders, but write the
  `![alt](src)` form with a short, specific alt so the user knows what they
  are looking at.
- A screenshot or `view_image` tool result shows the picture to you, not to
  the user. The message you write must contain the `![alt](src)` line.
- Show milestones and evidence: the fixed page, the failing state you found,
  the QA run. Not every step.

Recording a browser session:

```bash
agent-browser record start /tmp/checkout-run.webm
# ... drive the page ...
agent-browser record stop
```

Then put `![Checkout run](/tmp/checkout-run.webm)` in your reply. macOS screen
recordings (`screencapture -V 10 /tmp/clip.mov`) and any `.mp4` you produce
with ffmpeg work the same way.

## Showing structure

Cogpit draws three fenced blocks as interface instead of code. Write them in
YAML (JSON works too) inside a normal reply. A block that does not parse shows
as plain code, so a mistake costs nothing.

Use `cogpit-status` for counts you would otherwise write as a sentence:

````markdown
```cogpit-status
title: Wave 3 · 99 tickets
progress: { done: 35, total: 99 }
values:
  - { label: Merged today, value: 7 pull requests }
  - { label: Blocked on you, value: 4, tone: warning }
```
````

`tone` is `warning`, `danger` or `success`; leave it out for a neutral value.

Use `cogpit-decisions` whenever you need more than one answer from the user.
Do not ask several questions one after another and do not list them in prose.
The user answers each one in any order, and the answers come back to you as a
single message of `Decisions:` followed by one line per decision, in the form
`- <id>: <question> <answer>`.

````markdown
```cogpit-decisions
- id: sharp
  question: Bump sharp to 0.34 through its own PR?
  options: [Approve, Later, No]
  recommended: Approve
  detail: Separate worktree, merges when CI is green.
- id: worker
  question: Deploy the status page Worker?
  options: [Approve, Hold]
```
````

Give every decision a short `id`, two to five `options`, and `recommended`
when you have a view. Wait for the answers before acting on any of them.

Use `cogpit-checklist` for a plan you are about to carry out, and again to
show where it stands:

````markdown
```cogpit-checklist
title: Shipping w3-rooftop
items:
  - { text: Fix the P1 and both P2 findings, state: done }
  - { text: Codex review round 3, state: doing }
  - { text: Apply the ruleset, state: blocked, note: needs your permission }
  - Open the PR and merge when green
```
````

States are `todo` (the default), `doing`, `done`, `blocked` and `skipped`.
Keep one block per idea, and keep writing in prose around it: a block shows
the facts, your sentences say what they mean.

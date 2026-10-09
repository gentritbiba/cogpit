# Structured replies

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

Use `cogpit-decisions` when several related choices are easier to answer together.
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

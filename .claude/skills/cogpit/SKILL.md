---
name: cogpit
description: Delegate to local or remote sessions, recall history, and show local media or structured progress inside Cogpit.
---

# Cogpit

Read only the guide needed for the task:

| Need | Guide |
| --- | --- |
| Start or communicate with a child on this or another computer | [Sessions](references/cogpit-sessions.md) |
| Find or read previous sessions, turns and tool calls | [Memory](references/cogpit-memory.md) |
| Show progress, choices or a checklist as interface blocks | [Structured replies](references/structure.md) |

Inside Cogpit, `cogpit-session` is on PATH. Keep `COGPIT_SESSION_ID` so children
are linked to their parent. Use `cogpit-session help` for the full command list.

```bash
cogpit-session new "Investigate the parser and report findings" --wait --timeout 90
cogpit-session new "Run the Linux checks" --device Omarchy --wait --timeout 90
```

For browser work, read `cogpit-browser`. A delegated agent uses its own
`--session tmp-<unique>` browser and closes it when finished.

## Show media

Put markdown image syntax in the reply itself; a tool preview alone does not
show the user the file. Local paths must be absolute and live on the server
hosting the session. Download remote media before showing it.

```markdown
![Fixed checkout](/tmp/checkout.png)
![Checkout recording](/tmp/checkout.webm)
```

Images open in a viewer; videos play inline. Show useful evidence and milestones.
For a remote child, its local paths belong to that device; a text result sent to
the parent does not copy arbitrary media to the parent's machine.

Cogpit installs and refreshes these bundled skills on launch, including after
an update. Commands and examples here describe shipped capabilities. The session
CLI transfers Git workspaces; it does not yet offer arbitrary file attachments.

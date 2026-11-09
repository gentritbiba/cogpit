---
name: cogpit
description: How Cogpit works and how to use it from inside a session. Your replies can carry live interactive views (sliders, charts, simulations, 3D) that the user plays with right in the chat. Also covers delegating to sessions on this or another computer (cogpit-session), reading earlier sessions (cogpit-memory), the shared Browser panel (agent-browser), and showing media, progress or choices in replies.
---

# Cogpit

Cogpit is a workspace for Claude Code, Codex and GitHub Copilot CLI sessions. A
local server runs the agents and serves the desktop, browser and phone apps
where the user reads your replies, answers your questions and watches your
browser. You may be one of many sessions it is running.

## Your replies can be interactive

When seeing or touching an idea would explain it better than prose, such as a
slider that reshapes a curve, an algorithm to step through, a simulation, a
dashboard of numbers you computed or a 3D shape to turn, build a view: a small
React app Cogpit keeps on this machine and shows as a live card in the chat, in
the user's theme. You can update it after the user sees it. Read
[Interactive views](references/views.md), which starts with a working example,
before making one.

## Guides

Read only the guide your task needs:

| Need | Guide |
| --- | --- |
| What the user sees, where Cogpit keeps things, its local API | [How Cogpit works](references/how-cogpit-works.md) |
| Start, follow up, wait for, answer or stop other sessions; keep your status board | [Sessions](references/sessions.md) |
| Run a session on another computer | [Devices](references/devices.md) |
| Chat with your crew, or reply in a linked Slack thread | [Messaging](references/messaging.md) |
| Find or read earlier sessions, turns and tool calls | [Memory](references/memory.md) |
| Use a browser the user can watch or take over | [Browser](references/browser.md) |
| Show progress, decisions or a checklist as interface blocks | [Structured replies](references/structure.md) |

Inside Cogpit, `~/.cogpit/bin` is first on PATH (`cogpit-session` and the
`agent-browser` shim), and `COGPIT_SESSION_ID`, `COGPIT_PORT` and
`COGPIT_ORCHESTRATION_ROOT` are set. Keep them: they link the sessions you start
to yours and send commands to this server.

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

Cogpit refreshes this skill on every launch, including after an update, so the
commands here describe the version that is running.

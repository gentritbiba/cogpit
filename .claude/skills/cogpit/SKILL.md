---
name: cogpit
description: Working inside Cogpit or against a Cogpit server. Recall and search earlier agent sessions with the cogpit-memory CLI, create and drive sessions over the Cogpit HTTP API, and show screenshots, recordings and diagrams inline in the Cogpit timeline. Use when asked what happened in a past session, when you need to start or message another agent session, or whenever you have an image or video to show the user.
---

# Cogpit

Cogpit is a workspace for Claude Code, Codex and Copilot CLI sessions. This one
skill carries the three things an agent needs there. Read only the reference
that matches the job.

| Need | Read |
| --- | --- |
| Recall or search earlier sessions, drill into turns, tool calls and subagents | [references/cogpit-memory.md](references/cogpit-memory.md) |
| Create, message, poll, read or stop sessions through the HTTP API | [references/cogpit-sessions.md](references/cogpit-sessions.md) |
| Show a screenshot, recording or diagram to the user | "Showing images and videos" below |

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

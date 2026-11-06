# How Cogpit works

## The pieces

- **Server.** One Cogpit server per machine starts the agent CLIs, reads their
  transcripts and serves the apps. Its port is `$COGPIT_PORT`, else
  `~/.cogpit/port`, else `19384`. Never stop, restart or kill the Cogpit server
  or app from a session: yours runs under it, and a restart stops every session
  that was mid-turn.
- **Apps.** The desktop app, a browser tab (`npx cogpit`) and a phone all show
  the same server, and the user may be on any of them.
- **Agents.** Claude Code, Codex and GitHub Copilot CLI, each with the user's
  own login. Transcripts stay where each CLI writes them (`~/.claude/projects`,
  `~/.codex/sessions`, `~/.copilot/session-state`); Cogpit reads them in place.
  When one is missing or signed out, point the user at Settings → Agents or
  ⌘K → "Check agent setup", which show each CLI's state and the command that
  fixes it. `GET /api/agent-check` returns the same as JSON, read from local
  state without calling a model.
- **Devices.** One Cogpit can switch between other machines that run Cogpit.
  Each session runs on one machine, and its file paths belong to that machine.

## What the user sees

- Your replies render as Markdown. Your tool calls, command output and diffs
  appear in the timeline under each turn, so a reply does not need to repeat
  them.
- `![alt](/absolute/path)` shows images and videos inline, and the
  [structured blocks](structure.md) render as cards, and a
  [`cogpit-view` block](views.md) runs as a live page. Enabled Cogpit plugins can
  add their own fenced blocks; their instructions appear in your context while
  they are installed.
- Finishing a turn, or asking through your CLI's own question and approval
  tools, notifies the user, and pushes to their phone when they set that up.
  Those questions appear above the composer until answered.
- The user can send messages while you work. Depending on the agent, a message
  joins your running turn or waits for it to end.
- Panels beside the chat show the files you changed per turn, git worktrees,
  terminals and project scripts, the [Browser panel](browser.md), and
  integrations such as GitHub pull requests, ClickUp, Vercel and Cloudflare.
- Sessions you start with `cogpit-session` are linked to yours and appear as
  your crew.

## Where Cogpit keeps things

| Path | Contents |
| --- | --- |
| `~/.cogpit/bin` | `cogpit-session` and the `agent-browser` shim, rewritten on every start |
| `~/.cogpit/browser` | Browser profiles and their logins |
| `~/.cogpit/workspaces` | Worktrees for tasks other devices sent to this one |
| `~/.cogpit/notifications.json` | The notification inbox |
| `~/.cogpit/port` | Port of the running server |

Do not edit these by hand; Cogpit owns them.

## The local API

Prefer the CLIs: `cogpit-session` for sessions and devices
([sessions.md](sessions.md)), `cogpit-memory` for history
([memory.md](memory.md)) and `agent-browser` for browsers
([browser.md](browser.md)). They wrap the server's HTTP API at
`http://localhost:$PORT/api/`. `cogpit-session help` lists every command.

# Browser panel — design

Live view of the agent's `agent-browser` session inside Cogpit's right workspace,
with human interaction, persistent named browsers, and a skill that teaches agents
the rules.

## Goals

1. A **Browser** panel in the desktop workspace rail that streams the agent's
   headless browser live and lets the user click, type and navigate in it.
2. **Persistent named browsers.** A global `default` browser keeps logins across
   sessions and app restarts. Agents can create and later reuse other named
   browsers (`github`, `work-gmail`).
3. **Only the main agent drives visible browsers.** Subagents get private,
   throwaway browsers that never appear in the panel.
4. **Clear indicator** whenever the panel shows a browser other than `default`.
5. Agents learn all of this from a skill Cogpit ships itself — no install step.

## Findings that shaped the design

Verified against agent-browser 0.16.3 (see the research session for probes):

- Each agent-browser *session* is one Node daemon on a Unix socket plus one
  Chromium. The daemon is spawned by the first CLI call and inherits that
  call's environment. `AGENT_BROWSER_SOCKET_DIR`, `AGENT_BROWSER_PROFILE` and
  `AGENT_BROWSER_ARGS` are all honoured by the Rust CLI.
- agent-browser has a built-in WebSocket screencast server
  (`AGENT_BROWSER_STREAM_PORT`), but it can only be armed at daemon start, a port
  collision kills the whole daemon, and the stream dies silently on tab switch.
  **Not used.**
- Launching Chromium with `--remote-debugging-port=0` alongside Playwright's
  pipe writes `<profile>/DevToolsActivePort`. A second CDP client can attach to
  page targets, screencast and inject input while Playwright keeps working.
  No port allocation, no collision, tab-following is under our control.
- A persistent `--profile` dir keeps cookies and localStorage across
  close/reopen and survives SIGTERM of the daemon (Chromium dies with the pipe;
  no orphans). `DevToolsActivePort` goes stale after `close`, so "running" must
  be probed, not inferred from the file.
- A shell command cannot tell whether it runs inside a subagent: main-agent and
  subagent Bash tools have identical environments. Visibility must be
  structural, not a runtime check.

## Model

```
~/.cogpit/browser/
  profiles/<name>/        persistent Chromium profile per named browser
                          (+ DevToolsActivePort written by Chromium,
                           + .driver written by the shim: "<cogpitSessionId>")
  run/shared/             sockets + pids of named-browser daemons
  run/<cogpitSessionId>/  sockets + pids of that session's throwaway browsers
  sessions.json           { version, sessions: { [name]: { note, createdAt, lastUrl } } }
  plugin/                 Claude plugin dir carrying the cogpit-browser skill
~/.cogpit/bin/agent-browser   shim (bash) that routes every call into the tree above
```

**Named browser** = an agent-browser session whose name is not reserved. One
daemon, one persistent profile, one CDP port, listed in the panel, viewable and
drivable by the user. `default` always exists and is what `agent-browser` uses
when no `--session` is given. Names: `^[a-z0-9][a-z0-9_-]{0,39}$`.

**Throwaway browser** = any session named `tmp-*`. No profile, no CDP port,
socket dir scoped to the Cogpit session that created it. Never listed, never
viewable, reaped when that Cogpit session ends. This is the subagent lane. The
skill makes it a hard rule; the structure makes a violation harmless (a subagent
that uses a named browser only becomes visible, it cannot break anything).

Named browsers are global, like browser windows. Any Cogpit session's panel can
show any of them; two Cogpit sessions driving the same one at once will
interfere with each other, and the panel says who drove it last.

## Components

### Shim (`server/browser/shim.ts`)

Generated at server start into `~/.cogpit/bin/agent-browser` with the real
binary's absolute path baked in. Regenerated when its version comment changes.
Logic:

1. Session name = `--session X` from argv, else `$AGENT_BROWSER_SESSION`, else
   `default`.
2. `tmp-*` → export `AGENT_BROWSER_SOCKET_DIR=run/$COGPIT_SESSION_ID`, exec.
3. Otherwise → `mkdir -p profiles/<name>`, write `.driver`, export
   `AGENT_BROWSER_SOCKET_DIR=run/shared`, `AGENT_BROWSER_PROFILE`,
   `AGENT_BROWSER_ARGS=--remote-debugging-port=0`, exec.

If agent-browser is not on PATH the shim is not written and PATH is left alone;
the panel shows install instructions instead.

### Agent environment (`server/browser/agentEnv.ts`)

`browserAgentEnv(cogpitSessionId)` returns `{ PATH: "~/.cogpit/bin:" + PATH,
COGPIT_SESSION_ID }`. Applied where Cogpit builds an agent's env (SDK sessions,
one-shot runs, Codex, Copilot). Claude SDK sessions also receive
`plugins: [{ type: "local", path: ~/.cogpit/browser/plugin }]` so the skill is
present in every session without installation.

### Registry (`server/browser/registry.ts`)

Source of truth for existence is `profiles/`; `sessions.json` holds metadata.
`list()` merges both, always includes `default`, and for each name reports:
`running`, `driver` (Cogpit session id + age from `.driver`), `lastUrl`,
`note`, `createdAt`. `create(name, note)`, `update(name, patch)`,
`remove(name)` (stops first, deletes the profile).

### Daemons (`server/browser/daemons.ts`)

- `isRunning(name)`: pid file alive **and** `GET /json/version` on the
  DevToolsActivePort port answers within 500 ms.
- `launch(name, url)`: spawn the shim with `agent-browser --session name open url`.
- `stop(name)`: `agent-browser --session name close`, then SIGTERM the daemon.
- `reapSession(cogpitSessionId)`: SIGTERM every pid in `run/<id>/`, remove dir.
- `sweep()`: on start and every 60 s — drop dead pid files, reap `run/<id>/`
  whose Cogpit session is no longer live.
- `shutdown()`: reap all throwaway dirs and stop named daemons (profiles keep
  logins). Wired into `app-server.ts` cleanup.

### CDP client (`server/browser/cdp.ts`)

Minimal JSON-over-WebSocket CDP client using the existing `ws` dependency.
Per viewer: connect to the browser endpoint, `Target.setDiscoverTargets`, attach
to page targets with `flatten: true`, track `targetInfoChanged` for URL/title,
screencast the followed target (most recently created page unless the user
picks another), forward input, navigate/reload/history. Screencast size follows
the viewer's requested size so frames match the panel.

### Transport (`/__browser` WebSocket)

Mounted next to `/__pty` in both `server/pty-plugin.ts` (dev) and
`server/app-server.ts` (packaged), gated by `rejectWebsocketUpgrade`, proxied
by the hub for remote devices (the hub upgrade matcher is generalised from
`/__pty` to a small allow-list). Query: `?session=<name>`.

Client → server (JSON text): `viewport {width,height,dpr}`, `mouse`, `wheel`,
`key`, `navigate {url}`, `back`, `forward`, `reload`, `follow {targetId}`,
`launch {url}`.

Server → client: JSON text `status`, `tabs`, `page {url,title}`, `error`;
binary frames as `u32 headerLength · JSON header · JPEG bytes` with the header
carrying `deviceWidth`, `deviceHeight`, `targetId`.

### REST (`server/routes/browser.ts`, policy `admin`)

- `GET  /api/browser` → `{ installed, binaryPath, sessions: [...] }`
- `POST /api/browser/sessions` `{ name, note? }`
- `PATCH /api/browser/sessions/:name` `{ note? }`
- `DELETE /api/browser/sessions/:name`
- `POST /api/browser/sessions/:name/launch` `{ url? }`
- `POST /api/browser/sessions/:name/stop`
- `POST /api/browser/skill/install` `{ target: "claude" | "codex" }` — copies
  the skill into `~/.claude/skills` / `~/.codex/skills` for people whose agents
  do not run through Cogpit's SDK path.

### Panel (`src/components/BrowserPanel/`, id `cogpit.browser`)

Registered in `builtInWorkspacePlugin.tsx`, desktop only, `when: can("terminal")`
(same trust as the terminal: both are remote control of the host).

Layout, top to bottom:

1. **Session bar.** Picker `● default ▾` listing every named browser with a
   running dot, last-used age and "driven by <session>" when another Cogpit
   session drove it. `+ New browser…` prompts for a name and note. When the
   shown browser is not `default` the bar turns amber and reads
   **Not the default browser · Show default**. A `Follow agent` toggle (default
   on) makes the panel jump to whichever named browser this Cogpit session's
   agent last used.
2. **Nav bar.** Back, forward, reload, editable URL, tab chips when more than
   one page target exists.
3. **Viewport.** Canvas letterboxed on a dark field, scaled to fit. Clicking
   focuses it and captures the keyboard (Escape releases). Pointer, wheel and
   key events are scaled to device pixels and sent over the socket. A `LIVE` /
   `IDLE` pill sits top-left.
4. **Agent caption.** Bottom overlay showing the last `agent-browser` command
   this Cogpit session's agent ran against the shown browser (from the live
   transcript), fading after a few seconds. This is where the user *sees* what
   the agent is doing.

States: not installed (instructions + copy), browser not running (explain that
the agent opens it on demand, offer a URL field + Launch, offer the last URL),
connecting, live, disconnected (auto-reconnect with backoff, same as PTY).

Rail icon shows a live dot while this session's agent has used a browser in
the last 10 s.

### Skill (`server/browser/skill.ts`, name `cogpit-browser`)

Shipped as a Claude plugin at `~/.cogpit/browser/plugin`. Teaches:

- `agent-browser` works as documented; the user can watch and interact in
  Cogpit's Browser panel. Say so when starting browser work.
- No `--session` → the shared `default` browser; logins persist. Use it for
  anything that needs the user's accounts.
- `--session <name>` → a named persistent browser; create one for isolated,
  long-lived work. List them with `GET /api/browser`. Add a note via `PATCH`.
- **Subagents must use `--session tmp-<short-id>`** and `close` when done.
  Never touch `default` or a named browser from a subagent.
- Do not pass `--profile`, `--state`, `--session-name` or `--args`; Cogpit
  manages persistence and the debugging port.
- If the user needs to log in, ask them to do it in the panel, then continue.

## Security

- `/__browser` inherits the PTY trust gate; team policy `admin` for `/api/browser`.
- CDP listens on 127.0.0.1 without auth. That is the same local-user boundary
  agent-browser's own stream server has, and equivalent to the existing PTY.
- Names are validated before touching the file system; `default` cannot be
  deleted.

## Out of scope

Mobile layout (workspace panels are desktop-only today), Windows shim (`.cmd`),
per-session viewport presets, recording.

## Testing

- Server: shim script executed under bash against a fake binary that echoes its
  env; registry CRUD and validation; running-detection with a fake HTTP
  endpoint; CDP client against a fake WebSocket CDP server (targets,
  screencast, input, navigation); frame framing round-trip; route handlers with
  injected dependencies; agent env helper; reaper logic with fake pids.
- Client: socket hook with a mock WebSocket (reconnect, frame decode, viewport
  message); coordinate mapping; panel states with Testing Library.
- End to end: real agent-browser session viewed through the standalone build,
  driven and screenshotted with agent-browser itself.

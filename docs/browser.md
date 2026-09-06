# Browser Panel

A workspace panel that streams the agent's live `agent-browser` session, lets you click and type in it, and manages persistent named browsers with automatic login persistence across restarts.

## What It Does

The Browser panel displays the agent's headless Chromium in real time over the `/__browser` WebSocket transport. You can interact directly — click, type, navigate, go back/forward. The agent and you can drive the same browser, and you'll both see the same page.

Browser tabs are persistent. The shared `default` browser keeps cookies and localStorage across session restarts. You can create named browsers (`github`, `work-gmail`) for isolated, long-lived work. Subagents get private throwaway browsers (`tmp-*`) that disappear when the session ends.

## The Shim

The agent's PATH includes `~/.cogpit/bin/agent-browser`, a bash script that routes every `agent-browser` call into Cogpit's managed tree. The first call spawns a daemon; that daemon inherits the call's environment, so the shim decides the profile, socket dir, and debugging port at spawn time.

**How it routes:**
- **Named browser** (`agent-browser open …` or `agent-browser --session work open …`):
  - Profile: `~/.cogpit/browser/profiles/<name>` (persistent, survives restarts)
  - Socket dir: `~/.cogpit/browser/run/shared` (shared across all sessions)
  - Sets `--remote-debugging-port=0` so Chromium writes its debugging endpoint to `<profile>/DevToolsActivePort`
  - Records the Cogpit session id in `<profile>/.driver` (used to show "driven by another session" in the panel)

- **Throwaway browser** (`agent-browser --session tmp-abc123 open …`):
  - Socket dir: `~/.cogpit/browser/run/<cogpit-session-id>` (session-specific, reaped when the session ends)
  - No profile (no persistent data)
  - No debugging port override (invisible to the panel)

The shim validates names against `^[a-z0-9][a-z0-9_-]{0,39}$` and falls through to the real binary if invalid, so a command like `agent-browser --session 'My Browser'` runs unmanaged.

## Browser Types

| Type | Visibility | Persistence | Socket Dir | Profile | Use |
|------|------------|-------------|-----------|---------|-----|
| `default` | Panel | Persistent | `run/shared` | `profiles/default` | All work needing login, default choice |
| Named (e.g., `github`) | Panel | Persistent | `run/shared` | `profiles/github` | Isolated accounts, long-lived work |
| Throwaway (e.g., `tmp-s1`) | Hidden | None | `run/<session-id>` | None | Subagent scratch work, auto-cleanup |

The agent skill teaches subagents to use `--session tmp-<short-id>` and close when done. A subagent that uses a named browser becomes visible in the panel but does not break anything — it just shares that browser with the main session.

## File Layout

```
~/.cogpit/browser/
  profiles/
    default/            # Persistent Chromium profile (cookies, localStorage, etc.)
      DevToolsActivePort    # Written by Chromium; contains the CDP debugging port
      .driver               # Cogpit session id that owns this browser (empty if stopped)
    <name>/             # One per named browser
      ...
  run/
    shared/             # Sockets and pid files for named-browser daemons
      default.pid
      github.pid
      ...
    <session-id>/       # Throwaway browsers for one Cogpit session
      tmp-abc123.pid
      ...
  sessions.json         # Metadata: notes, created/last-used times, last URLs
  plugin/
    .claude-plugin/
      plugin.json       # Plugin manifest
    skills/
      cogpit-browser/
        SKILL.md        # Agent-facing skill

~/.cogpit/bin/agent-browser    # The shim (bash), regenerated on Cogpit start
```

## How the Panel Attaches

1. Cogpit launches the agent with `COGPIT_SESSION_ID` set. The shim prepends `~/.cogpit/bin` to PATH.

2. When the agent calls `agent-browser`, the shim routes it into the tree above. The first call spawns a Node daemon on a Unix socket plus one Chromium. Chromium writes its debugging endpoint (`ws://127.0.0.1:<port>/devtools/browser/<id>`) to `<profile>/DevToolsActivePort`.

3. The panel opens a second CDP WebSocket client to that endpoint — it does not interfere with the agent's own connection. The CDP client:
   - Discovers page targets (browser tabs)
   - Attaches to each one
   - Starts a screencast of the most recently created tab (or one you pick)
   - Forwards mouse, wheel, and keyboard events
   - Handles navigation and history

4. Frames travel to the panel as binary on the `/__browser` WebSocket: a 4-byte header length + JSON header (device size, target id, scale/scroll) + JPEG bytes.

5. The panel maps your pointer clicks and keystrokes back to device coordinates using the frame header's scale and scroll offsets.

The connection works over the hub for remote devices; the hub route matcher is `^/hub/[^/]+/(__pty|__browser)$`.

## Viewport Emulation

While the panel is open, the page viewport size is driven by the panel's own size, not by the agent's Chromium settings.

**What changes:**
- The panel sends `viewport` messages whenever it resizes or you drag its splitter.
- The CDP client runs `Emulation.setDeviceMetricsOverride` with the panel's dimensions (clamped to 1024–4096 width, scaled to panel aspect ratio, dpr clamped to 1–2).
- The page re-renders at the new size.

**What the agent sees:** When the panel is open, `window.innerWidth` and page breakpoints reflect the panel's size, not what the agent wrote to Chromium. This means responsive pages adapt to the panel.

**When you close the panel:** The CDP client reads the page's original layout metrics (`Page.getLayoutMetrics`) and `window.devicePixelRatio` on first attach, then restores those values when it un-follows or closes. So the agent's own viewport settings survive a panel open-and-close.

The minimum panel width is 1024 pixels (keeps pages on their desktop breakpoints even in a narrow sidebar). Height is adjusted to match the panel's aspect ratio. Neither dimension can exceed 4096.

## Agent Skill

Cogpit ships the `cogpit-browser` skill as a local plugin to every session, so agents learn the rules without installation. The skill covers:
- What the Browser panel is and to mention it when starting browser work
- Default browser semantics and login persistence
- Named browsers: `--session name`, list via `GET /api/browser`, add notes via `PATCH`
- **Subagent rule**: `--session tmp-<short-id>`, `close` when done, never touch `default` or named browsers
- Flags never to pass: `--profile`, `--state`, `--session-name`, `--args`, `--headed`
- Login hand-off: ask the user to log in in the Browser panel, then continue

The standard `agent-browser` skill still applies for all commands.

## REST API

All routes require admin trust (same as PTY). Failures send JSON errors with status codes.

| Method | Route | Body | Response | Notes |
|--------|-------|------|----------|-------|
| GET | `/api/browser` | — | `{installed, binaryPath, sessions:[...]}` | Status for the panel |
| POST | `/api/browser/sessions` | `{name, note?}` | 201 info / 400 invalid / 409 exists | Create named browser |
| PATCH | `/api/browser/sessions/:name` | `{note?}` | info / 404 not found | Update note |
| DELETE | `/api/browser/sessions/:name` | — | 204 / 400 if default | Delete browser (stops it first) |
| POST | `/api/browser/sessions/:name/launch` | `{url?: string}` | Queued | Launch or reopen browser (default `about:blank` or last URL) |
| POST | `/api/browser/sessions/:name/stop` | — | — | Stop the daemon (profile preserved) |
| POST | `/api/browser/skill/install` | `{target: "claude"\|"codex"\|"copilot"}` | `{path}` | Copy skill to `~/.claude/skills` etc. for agents not run through Cogpit |

URL length is capped at 2048 characters. Names are validated; `default` cannot be deleted. Launch URL schemes are allow-listed (`http`, `https`, `about`); loopback forms without a scheme are prefixed with `http://`.

## Security

- The `/__browser` transport inherits the PTY authorization gate; only sessions with terminal access can connect.
- The policy for all REST routes is `admin` (same as terminal/PTY).
- CDP listens only on `127.0.0.1` without auth — the same local-user boundary as the agent-browser process itself.
- Browser names and session ids are validated before touching the file system.
- `default` cannot be deleted via any API.
- When a Cogpit session is revoked, its open browser panel connection is closed immediately and stops receiving video.

## Troubleshooting

**Browser shows as stopped even though the agent is using it**

The panel polls every 2 seconds while stopped. If the page opens but does not appear:
- The daemon might have crashed. Kill the process: `killall -9 chrome-headless-shell`.
- The profile might be in use by another Chromium process (e.g., from a manual agent-browser command). Close that and try again.

**The panel is blank or frozen**

A stale `DevToolsActivePort` file can cause attachment to fail:
- Stop the browser via the panel UI or `POST /api/browser/sessions/default/stop`.
- Delete the stale port file: `rm ~/.cogpit/browser/profiles/default/DevToolsActivePort`.
- Reopen the browser.

**"agent-browser" not installed on this machine**

The panel shows an install prompt and a command to run:
```bash
npm i -g agent-browser && agent-browser install
```
Reload Cogpit once installed. Or use the panel's "Install agent skill" button to copy the skill into `~/.claude/skills` for agents not launched through Cogpit.

**Full reset**

If a browser is in a bad state, stop it, delete its profile, and reopen:
```bash
# Stop via API or the panel, then:
rm -rf ~/.cogpit/browser/profiles/<name>
```

On restart, Cogpit will recreate the profile. Logins and data are lost.

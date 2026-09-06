# Browser Panel

A workspace panel that streams the agent's live `agent-browser` session, lets you click and type in it, and manages persistent named browsers with automatic login persistence across restarts.

## What It Does

The Browser panel displays the agent's headless Chromium in real time over the `/__browser` WebSocket transport. You can interact directly — click, type, navigate, go back/forward. The agent and you can drive the same browser, and you'll both see the same page.

Browser tabs are persistent. The shared `default` browser keeps cookies and localStorage across session restarts. You can create named browsers (`github`, `work-gmail`) for isolated, long-lived work. Subagents get private throwaway browsers (`tmp-*`) that are reaped automatically.

## The Shim

The agent's PATH includes `~/.cogpit/bin/agent-browser`, a bash script that routes every `agent-browser` call into Cogpit's managed tree. The first call spawns a daemon; that daemon inherits the call's environment, so the shim decides the profile, socket dir, and debugging port at spawn time.

**How it picks a name:** `--session X` or `--session=X` from argv, else `$AGENT_BROWSER_SESSION`, else `default`.

**How it routes:**
- **Named browser** (`agent-browser open …` or `agent-browser --session work open …`):
  - Profile: `~/.cogpit/browser/profiles/<name>` (persistent, survives restarts)
  - Socket dir: `~/.cogpit/browser/run/shared` (shared across all sessions)
  - Sets `--remote-debugging-port=0` so Chromium writes its debugging endpoint to `<profile>/DevToolsActivePort`
  - Writes `$COGPIT_SESSION_ID` to `<profile>/.driver` (used to show "driven by another session" in the panel)

- **Throwaway browser** (`agent-browser --session tmp-abc123 open …`):
  - Socket dir: `~/.cogpit/browser/run/<cogpit-session-id>`, or `run/shared` when `$COGPIT_SESSION_ID` is not a valid id
  - No profile (no persistent data)
  - No debugging port override (invisible to the panel)

**Two fall-through paths** run the real binary unmanaged, leaving the environment alone:
- Neither `$COGPIT_BROWSER_HOME` nor `$HOME` is set, so there is no tree to route into.
- The name fails `^[a-z0-9][a-z0-9_-]{0,39}$` — `agent-browser --session 'My Browser'` runs unmanaged.

(A third case is not a fall-through: if the real binary the shim was generated against is gone or resolves back to the shim itself, it exits 127 and asks you to restart Cogpit.)

`$COGPIT_BROWSER_HOME` overrides `~/.cogpit/browser` for the whole tree, in both the shim and the server. It is what the test suite sets; there is no reason to set it by hand.

## Browser Types

| Type | Visibility | Persistence | Socket Dir | Profile | Use |
|------|------------|-------------|-----------|---------|-----|
| `default` | Panel | Persistent | `run/shared` | `profiles/default` | All work needing login, default choice |
| Named (e.g., `github`) | Panel | Persistent | `run/shared` | `profiles/github` | Isolated accounts, long-lived work |
| Throwaway (e.g., `tmp-s1`) | Hidden | None | `run/<session-id>` or `run/shared` | None | Subagent scratch work, auto-cleanup |

Subagents must use `--session tmp-<short-id>` and close when done. In sessions Cogpit starts through the SDK, recognized subagent browser calls are redirected onto a `tmp-` browser before they run. See "What every agent is told" below for coverage and limitations.

### When a throwaway is reaped

Only a spawn that owns exactly one Cogpit session passes a real `COGPIT_SESSION_ID`, and only those throwaways land in `run/<session-id>`, which the sweeper reaps within 60 seconds of the session ending. The rest — a shared app-server or headless CLI serving every session at once, which has no single session to name — pass a deliberately invalid id, so their throwaways land in `run/shared` and are reaped when Cogpit exits instead.

### One Cogpit reaps, the rest do not

`run/<session-id>` names a session only the process that started it knows about, so a second Cogpit on the same tree would read every one of them as finished. Reaping is single-owner: `~/.cogpit/browser/sweeper.owner` names the holder by pid and start time, a holder whose process is gone can be taken over, and a non-owner still installs the shim and writes the plugin but never sweeps and never stops a named daemon on the way out. The standard Electron dev flow (Vite plus the app server) runs two instances, which is exactly the case this protects.

## File Layout

```
~/.cogpit/browser/
  profiles/
    default/            # Persistent Chromium profile (cookies, localStorage, etc.)
      DevToolsActivePort    # Written by Chromium; contains the CDP debugging port
      .driver               # Cogpit session id of the last call routed through the shim
                            #   (empty when the caller owned no session, and after a
                            #    stop that went through Cogpit; its mtime is lastUsedAt)
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
  sessions.json         # Metadata: notes, createdAt, last URLs
  sweeper.owner         # pid + start time of the Cogpit allowed to reap this tree
  plugin/
    .claude-plugin/
      plugin.json       # Plugin manifest
    skills/
      cogpit-browser/
        SKILL.md        # Agent-facing skill

~/.cogpit/bin/agent-browser    # The shim (bash), regenerated on Cogpit start
```

`lastUsedAt` in the API is the mtime of `.driver`, not a field in `sessions.json`.

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

The retry loop is server-side, not in the panel: while a browser is stopped the server polls every 2 seconds and attaches as soon as it answers, so a browser the agent opens on its own appears without any user action. An attach that stalls is abandoned after 10 seconds and the poll resumes; individual CDP calls give up after 10 seconds so a wedged Chromium cannot hold a socket open.

Screencast frames are capped at 1920 device pixels on each side (JPEG, quality 80), so a very large panel on a retina display streams at that ceiling rather than at its full pixel count.

## Viewport Emulation

While the panel is open, the page viewport size is driven by the panel's own size, not by the agent's Chromium settings.

**What changes:**
- The panel sends `viewport` messages whenever it resizes or you drag its splitter.
- The CDP client runs `Emulation.setDeviceMetricsOverride` with the panel's dimensions (clamped to 1024–4096 width, scaled to panel aspect ratio, dpr clamped to 1–2).
- The page re-renders at the new size.

**What the agent sees:** When the panel is open, `window.innerWidth` and page breakpoints reflect the panel's size, not what the agent wrote to Chromium. This means responsive pages adapt to the panel.

**When you close the panel:** The CDP client reads the page's original layout metrics (`Page.getLayoutMetrics`) and `window.devicePixelRatio` lazily — on the tab it is about to override, immediately before the first override lands on it, not for every tab at attach — then hands those values back when it un-follows or closes. So the agent's own viewport settings survive a panel open-and-close. A tab the panel never followed is never measured and never touched.

The minimum panel width is 1024 pixels (keeps pages on their desktop breakpoints even in a narrow sidebar). Height is adjusted to match the panel's aspect ratio. Neither dimension can exceed 4096.

## What Every Agent Is Told

The skill below is the full manual, but a skill is lazy: only its `description` reaches the model, and the body loads only if the model chooses to read it. An agent that already knows `agent-browser` never does — so it never learns that the user can watch, and a subagent never learns the `tmp-` rule. The two facts that cannot be optional therefore travel outside the skill, through the SDK, in `server/browser/agentContext.ts`:

- **`BROWSER_CONTEXT_APPEND`** — four lines appended to the system prompt (`systemPrompt: { type: "preset", …, append }`), so they are in context on every request with no model discretion: the panel exists and the user can click in it, no `--session` means the shared `default` browser, say which browser you are using, subagents use `--session tmp-<id>`, and the skill has the rest.
- **`browserPreToolUseHook`** — a `PreToolUse` hook on the shell tool. When the call comes from a subagent (`agent_id` present; the main thread has none), a shared shell scanner distinguishes executable words from arguments, comments and redirection targets. Direct `agent-browser` calls, including quoted executable paths and calls through supported `env`, `command`, `exec`, `npx` and `bunx` forms, are rewritten onto `tmp-<agent-id>` via `updatedInput`. `additionalContext` tells the subagent which browser it actually got. Valid literal `tmp-*` calls stay unchanged.

Ordinary mentions in recognized data commands, such as `git commit -m "fix agent-browser"`, `rg agent-browser server`, and `cat /tmp/agent-browser`, pass unchanged. The same scanner keeps those mentions out of panel captions. Quoted separators stay inside their argument, so `agent-browser fill @e1 "a; b" --session work` can be redirected safely. Quotes alone do not make text inert: `sh -c 'agent-browser open x'` executes it.

The scanner is deliberately bounded. It denies browser-bearing commands involving interpreters, command substitutions, heredocs, unsupported launchers or unsupported compound shell syntax. An unfamiliar command receiving browser text is ambiguous, rather than assumed to consume it as data. It also denies dynamic browser arguments, malformed or duplicate session flags, and invalid browser names, even when the first flag starts with `tmp-`. It validates the whole command before returning edits. Split denied browser work into direct calls with literal arguments; a denial never returns a partial rewrite.

This hook prevents mistakes in recognizable shell calls, not arbitrary program execution. Browser launches hidden inside scripts, aliases, other tools, or dynamically constructed executable names cannot be fully classified from a Bash command string. The hook cannot guarantee isolation against those paths. Strict isolation would require separate subagent processes with enforced browser access boundaries; an identical inherited environment and a PATH shim cannot supply that.

Hooks were chosen over `canUseTool` because the CLI skips `canUseTool` entirely under `bypassPermissions`, which is Cogpit's common mode; hooks fire in every permission mode.

Both are registered only when `agent-browser` is installed — the gate is the shim's presence, the same signal `browserAgentEnv` uses — so a machine without it pays nothing.

**This covers the sessions Cogpit starts through the SDK, and nothing else.** An agent run outside Cogpit, or a CLI Cogpit drives some other way, gets neither the appended context nor the hook; for those, the skill install below is the only channel, and the `tmp-` rule is back to being advice.

## Agent Skill

Cogpit delivers the `cogpit-browser` skill two ways. Only the first is automatic:

- **As a local plugin**, passed to the sessions Cogpit drives through the SDK. `~/.cogpit/browser/plugin` is written at startup in the plugin shape the descriptor declares (`.claude-plugin/plugin.json` plus `skills/`). It lives inside Cogpit's own tree, so nothing the user owns is touched.
- **As an installed skill**, copied into an agent CLI's own global skills directory (`~/.claude/skills`, `~/.codex/skills`, `~/.copilot/skills`) **only when asked**. That is what reaches one-shot runs, agents started outside Cogpit, and the CLIs that take no plugin. It is idempotent — an unchanged file is left alone — and one CLI failing does not stop the others.

**Cogpit never writes into your global agent configuration unless you ask it to.** Those directories are the user's, often kept in version control, so starting the server adds nothing to them. Installing is a deliberate act: the **Agent skill…** item in the panel's browser menu (also reachable from the empty state when `agent-browser` is missing) lists every CLI, where the file would go and whether it is already there, or `POST /api/browser/skill/install` does the same over HTTP.

The skill covers:
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
| POST | `/api/browser/sessions/:name/launch` | `{url?: string}` | 200 `{ok:true}` / 400 bad url / 502 would not start | Launch or reopen browser (default `about:blank` or last URL) |
| POST | `/api/browser/sessions/:name/stop` | — | 200 `{ok:true}` | Stop the daemon (profile preserved) |
| GET | `/api/browser/skill` | — | `{targets:[{kind, label, configRoot, installed, automatic}]}` | Where the skill can go, and where it already is |
| POST | `/api/browser/skill/install` | `{target: "claude"\|"codex"\|"copilot"\|"all"}` | `{paths}` | Copy skill to `~/.claude/skills` etc. for agents not run through Cogpit |

URL length is capped at 2048 characters. Names are validated; `default` cannot be deleted. Launch URL schemes are allow-listed (`http`, `https`, `about`); a url with no scheme gets `http://` when it is loopback (`localhost`, `127.x`, `0.0.0.0`, `::1`) and `https://` otherwise, so `example.com:8080` becomes `https://example.com:8080` while `localhost:3000` becomes `http://localhost:3000`.

`launch` is not fire-and-forget: it waits for the shim, so a browser that fails to start answers 502 with the CLI's stderr. `DELETE` stops the browser before deleting its profile — that ordering lives in the route, so a live Chromium is never writing into a directory that is being removed.

`skill/install` is the only browser route that writes outside `~/.cogpit`, and it runs only on request. `"all"` covers every CLI whose config root already exists — a CLI you do not have is skipped rather than created — while a single target creates the directory it needs. `automatic` marks the CLIs the local plugin already reaches, which need no install for sessions Cogpit starts itself.

## Security

- The `/__browser` transport inherits the PTY authorization gate; only sessions with terminal access can connect.
- The policy for all REST routes is `admin` (same as terminal/PTY).
- CDP listens only on `127.0.0.1` without auth — the same local-user boundary as the agent-browser process itself.
- Browser names and session ids are validated before touching the file system.
- Nothing here writes into the user's global agent configuration on its own; the skill install is the one path that does, and only when it is called.
- `default` cannot be deleted via any API.
- When a Cogpit session is revoked, its open browser panel connection is closed immediately and stops receiving video.

## Troubleshooting

Everything below goes through Cogpit's own stop, which is the only supported way to end a managed browser. Cogpit refuses to signal a process whose `ps` line does not contain `agent-browser`, so a stray `kill` by hand loses that guard — and the daemon is the `agent-browser` Node process recorded in `~/.cogpit/browser/run/shared/<name>.pid`, not the Chromium under it. Never `killall` a Chromium: it takes down every headless browser on the machine, including ones nothing here owns.

**Stopping a browser**

Use the panel's Stop button, or:

```bash
PORT="${COGPIT_PORT:-$(cat ~/.cogpit/port 2>/dev/null || echo 19384)}"
curl -s -X POST "http://localhost:$PORT/api/browser/sessions/default/stop"
```

Stop closes the browser politely, then SIGTERMs the daemon and SIGKILLs it if it has not gone within 3 seconds. The profile — and every login in it — is untouched.

**Browser shows as stopped even though the agent is using it**

The server polls every 2 seconds while stopped, so this resolves itself unless something is actually wrong:
- The daemon may have crashed and left its pid file behind. Stop the browser as above; the sweeper also drops dead pid files every 60 seconds.
- The profile may be in use by a Chromium started outside Cogpit (a manual `agent-browser` run with its own `--profile`). Close that one and try again.

**The panel is blank or frozen**

A stale `DevToolsActivePort` file can make the attach fail:
- Stop the browser (panel button or the `stop` route above).
- Delete the stale port file: `rm ~/.cogpit/browser/profiles/default/DevToolsActivePort`.
- Reopen the browser from the panel.

**"agent-browser" not installed on this machine**

The panel shows an install prompt and a command to run:
```bash
npm i -g agent-browser && agent-browser install
```
Reload Cogpit once installed — the shim is written at startup and only when the real binary is on PATH. The panel's "Install the agent skill…" button opens the same dialog as the browser menu's **Agent skill…** item, which copies the skill into a CLI's global skills directory for agents not launched through Cogpit. Nothing is copied until you pick a CLI there.

**Full reset**

If a browser is in a bad state, stop it and delete its profile:
```bash
# Stop it first (panel button, or the stop route above), then:
rm -rf ~/.cogpit/browser/profiles/<name>
```

The shim recreates the profile on the next `agent-browser` call for that name — no restart needed. Logins and data are lost.

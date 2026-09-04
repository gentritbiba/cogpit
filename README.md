<p align="center">
  <img width="2098" height="1289" alt="Screenshot 2026-03-11 at 4 31 18 AM" src="https://github.com/user-attachments/assets/22f4858d-2b17-4f1b-8cd7-f5d07dacd620" />
</p>

<h1 align="center">Cogpit</h1>

<p align="center">
  <em>A real-time control center for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>, <a href="https://github.com/openai/codex">Codex</a>, and <a href="https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli">GitHub Copilot CLI</a> sessions.</em>
</p>

<p align="center">
  <a href="https://cogpit.dev">Website</a> · <a href="https://github.com/gentritbiba/cogpit/releases">Download</a>
</p>

---

Cogpit brings Claude Code, Codex, and GitHub Copilot CLI into one live, interactive control center. It uses provider-native control APIs for active work and the CLIs' on-disk history for restoration, so you can watch, steer, approve, and debug agents without leaving your workflow.

Available as a **desktop app** (macOS, Linux, Windows) or a **browser-based** dev server.

## Download

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `Cogpit-x.x.x-arm64.dmg` |
| macOS (Intel) | `Cogpit-x.x.x.dmg` |
| Linux (AppImage) | `Cogpit-x.x.x.AppImage` |
| Linux (Arch) | `Cogpit-x.x.x.pacman` |
| Windows (x64) | `Cogpit-x.x.x-setup.exe` |

> **Windows is newly supported and not yet widely tested.** The installer is
> unsigned, so SmartScreen shows an "unknown publisher" prompt — choose
> **More info → Run anyway**. Please file an issue if you hit a problem.

> **Prerequisite:** Install at least one supported CLI: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), or [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli). Cogpit uses your existing CLI login — no separate API key is needed.

## Why Cogpit

Claude Code, Codex, and Copilot CLI are powerful, but the terminal gives you a narrow view. Cogpit gives you the full picture:

- **See everything at once** — live sessions, token costs, file changes, and agent activity in one screen
- **Talk to your agents** — send messages, approve plans, answer questions, interrupt turns, and branch where the provider supports it
- **Understand usage** — per-turn token/cache breakdowns, published-price estimates, and provider-native plan, credit, and rate-limit monitoring where available
- **Debug faster** — compact tool-call summaries, expandable thinking blocks, line-by-line edit diffs, and complete session history
- **Follow multi-agent work** — inspect recorded subagent activity from providers that expose it
- **Undo supported sessions** — rewind to an earlier turn with branching and file operation reversal
- **Share a Claude Code session** — hand one live session to someone over a passphrase-protected link, without giving them the rest of the machine

## Features

### Multi-Provider Support
Start sessions with Claude Code, Codex, or GitHub Copilot CLI from the same interface. Model settings come from the installed CLIs, and provider-specific controls appear only when the selected CLI supports them. Claude and Codex catalogs include descriptions, recommended reasoning levels, image support, personality support, and speed tiers when advertised. If a Codex model is unavailable, Cogpit visibly reports the fallback and retries with the provider default.

Copilot support covers existing-session discovery and new, resumed, and branched chats. It supports model and reasoning-effort selection, image input, Ask/Plan/Autopilot/Full access modes, approvals, questions, interruption, and deletion. Timelines include nested subagent activity, file changes, pull request links, and recorded usage and cost data. Copilot's native rewind can restore conversation and file changes, but the runtime has no redo. Cogpit does not share Copilot sessions or expose Copilot goals, workflows, or MCP editing; its `.copilot/` instructions, settings and skills are browsable in the configuration editor. Discovery reads Copilot CLI events from `~/.copilot/session-state`. VS Code Copilot Chat data, including `~/Desktop/chatSessions`, is not imported.

### Live Session Monitoring
Stream active sessions via SSE. Watch Claude, Codex, or Copilot think, call tools, and edit files in real time. Codex live work uses its persistent app-server control plane for native threads, turns, steering, interruption, goals, and approvals, with a legacy CLI fallback for older installations. Pull requests opened during a session appear as clickable links in the session list.

Search the desktop sidebar or a project's Sessions page for the work behind a pull request. Enter `#157`, `honest-cms #157`, or paste a GitHub pull request URL. Cogpit searches sessions that created or worked on that pull request and labels the exact match.

The desktop sidebar and mobile Sessions tab use the same searchable live-and-recent session list, including status and attention cues.

Claude token-level streaming is enabled by default. Set `COGPIT_STREAM_PARTIAL=0` (or `false`, `off`, or `no`) before launching Cogpit to disable partial-message streaming while leaving completed session updates intact.

### Interactive Chat
Send or steer messages with a model and effort override, toggle Fast where supported, and choose Full access (default), Workspace, or more restrictive modes. On capable Claude models, Ultracode can be enabled for new or active sessions to pin XHigh effort and standing multi-agent orchestration; it is off until you click it and never carries over into another session. Slash command autocomplete comes from project skills and commands. Image drag-and-drop, paste, and conversion are enabled only for models that accept images.

### Long-Running Goals
Create persistent goals above the composer and monitor status, tokens, elapsed time, and provider-native evaluator feedback. Codex goals can optionally use token budgets and explicit pause/resume controls; Claude goals follow Claude Code's native goal lifecycle.

### Conversation Timeline
Structured view of every turn: user messages, thinking blocks, assistant text with syntax-highlighted Markdown, compact tool rows, LCS-based edit diffs, and compaction markers. Mutating calls use normal text, read-only calls stay muted, and red is reserved for failures. Virtualized for smooth scrolling across long sessions.

Adjacent Bash calls share one command card. Single commands and labeled command batches use the same compact layout, with output and failures kept on the command that produced them.

Agent work stays open while a turn is live. Completed turns with a final answer fold that work behind a duration row, and each turn's file summary is a separate collapsed disclosure.

### Sub-Agent Viewer
When Claude Code, Codex, or Copilot CLI spawns subagents, Cogpit correlates the activity into one record per agent. The session Stats panel shows each agent's status, task summary, duration, and tool count when available. The parent timeline keeps the work in context, and recorded agent threads remain inspectable.

### Token Analytics & Cost Tracking
Per-turn token usage (uncached input, cached input, cache creation, and output), published model pricing, SVG charts, context usage, tool/error/duration breakdowns, and provider-native account limits where available. Cogpit leaves cost unavailable when a GPT model has no published USD price instead of inventing a fallback value.

### Power & Activity Monitor
Open the header monitor to inspect Cogpit's CPU, memory, event-loop, file/stream, and API activity. The desktop app also breaks usage down by Electron process, and the monitor polls only while it is open.

### Process Leak Monitor
Automatically detect and clean up leaked agent processes: orphaned Claude sessions, hot headless browsers, and abandoned scripts that drain battery or hog CPU. The header indicator shows active leaks with severity (CPU%, age); one-click cleanup kills only suspected leaks. Two-sweep confirmation prevents accidental kills of transient processes. Notifications announce automatic cleanup.

### Notifications
Get told when an agent finishes a turn or needs an answer — on the desktop, and on your phone when you have walked away.

Desktop notifications are presented by Cogpit itself, so they carry the app icon, bounce the dock, and open the session when clicked. They are suppressed only when the window is focused *and* already showing that session. The headless `cogpit-server` has no Electron main process, so it falls back to `osascript` on macOS and has no desktop channel elsewhere — there, push is the only channel.

Phone push goes out via [ntfy](https://ntfy.sh) only when nobody is at the desktop: no window, screen locked or suspended, or 120 s without keyboard/mouse input anywhere on the machine (system idle, not window focus). Configure it in `~/.cogpit/push.json` — create it `chmod 600`, since the topic is a bearer secret and anyone who knows it can read every notification:

```json
{ "topic": "your-private-topic", "publicUrl": "https://cogpit.example.com" }
```

| Key | Env override | Default | Purpose |
|-----|--------------|---------|---------|
| `topic` | `COGPIT_NTFY_TOPIC` | — | ntfy topic; `[-_A-Za-z0-9]`, ≤64 chars. Push is off until set. |
| `ntfyUrl` | `COGPIT_NTFY_URL` | `https://ntfy.sh` | Base URL of the ntfy server (self-hosted works). |
| `token` | `COGPIT_NTFY_TOKEN` | — | Sent as `Authorization: Bearer` for protected topics. |
| `publicUrl` | `COGPIT_PUBLIC_URL` | — | Reachable Cogpit base URL. Without it, pushes carry no click target rather than a dead `127.0.0.1` link. |

Env overrides let a headless box be configured entirely through systemd. Edits take effect without a restart.

Notifications are raised by Cogpit itself — no agent hooks required. A server-side session activity monitor sweeps recently modified Claude Code, Codex, and Copilot transcripts, including sessions started in a terminal, and notifies when a turn completes or starts waiting for permission. Every raised notification lands in a persisted inbox (`~/.cogpit/notifications.json`, bell icon in the header, `GET /api/notifications`), where clicking an entry deep-links to its session.

### Branching and History Controls
Create branches from earlier turns. Claude Code and Codex sessions use Cogpit's undo/redo graph and file-operation reversal. Copilot uses its native fork and rewind APIs, with optional file restoration, but does not provide redo.

### File Changes
Track all modifications across a session. Net-diff view (aggregated) or per-edit view (chronological). Sub-agent attribution. Open files in your editor or view git diffs directly.

### Worktree Management
Open Worktrees from the desktop right activity rail to list active git worktrees with dirty/clean status, commits-ahead count, and linked sessions. Create PRs directly. Bulk cleanup of stale worktrees.

### Permissions & MCP Server Selector
Use provider-specific access profiles and tool-level policies. Full access is the default; select a more restrictive mode to enforce approval workflows or limit operations. Native Codex command, file, and network approval requests—including requests raised by nested subagents—appear in the composer, expose only decisions allowed by the runtime, and resume directly when answered. Choose which MCP servers to enable per session from a searchable selector.

### Agent Configuration Editor
Browse and edit each installed CLI's own configuration from the dashboard — `.claude/`, `.codex/` and `.copilot/`, at global and project scope. Instruction files, settings and skills for all three, plus slash commands, agents, themes and MCP server configs for the CLIs that have them. Changes are written to disk immediately, no terminal needed.

### Command Palette & Keyboard Shortcuts
Press `Cmd+K` to open the command palette: navigate projects, sessions, toggle panels, access settings, and more. Customize keyboard shortcuts globally with conflict detection and preset categories (General, View, Tools).

### Compile-time UI Plugins
Source builds can add isolated UI plugins to the right workspace rail. Panels can react to the current project or session, expose live indicators, and preserve their state while another panel is active. Cogpit includes GitHub and Vercel Deployments plugins. The GitHub plugin shows Actions (workflow runs, jobs, and steps), Pull Requests (with checks, reviews, conflicts, and comments; linked to Cogpit sessions that worked on them), and Issues (filtered by assignee, author, or label; droppable into the composer) through the authenticated `gh` CLI. Vercel Deployments uses Vercel CLI 50.5.1 or newer to list deployments and fetch build output for the project linked at the exact active-session root. Both integrations are read-only. If either CLI is unavailable or needs setup, only its panel shows guidance and the rest of Cogpit remains usable. See the [plugin guide](docs/plugins.md) for setup details, the typed API, and the registration flow. Runtime plugin installation is not supported yet.

### Integrated Terminals & Project Scripts
On desktop, open terminals and discovered project scripts from one bottom process panel. Runs share the same tabs and output area. Select terminal output and add it to the chat composer with one action.

### Project File Editor & Previews
Edit project files securely: read and write to any file in your project with optimistic concurrency control (mtime-based conflict detection prevents lost writes). Preview viewport with zoom controls for rendered content. File suggestions with `@-mention` autocomplete in the chat input.

Enable **Configuration → Open files in Cogpit** to route every "open in editor" action — file-change cards, git diff buttons, file links in agent output, project context menus — into this panel instead of launching an external editor. It works over the network too, so files on a remote device open in place rather than copying a path to the clipboard.

### Network Access
Access Cogpit from your phone or tablet on the same LAN. Password-protected with rate-limited auth and full feature parity with the local client.

Remote **browser** access requires HTTPS. Cogpit keeps browser sessions in a
host-only, `HttpOnly`, `Secure`, `SameSite=Strict` cookie, so a plaintext LAN URL
cannot issue a browser session. Put Caddy, nginx, or a tunnel with TLS in front
of the loopback listener and open that HTTPS origin. A displayed `http://` LAN
listener address remains usable for authenticated Cogpit hub/device traffic,
but should not be opened as a remote browser login URL.

Network passwords must contain at least 16 characters. New credentials use a
versioned scrypt hash, and remote browser sessions expire after 30 minutes of
inactivity or eight hours total. Changing the password or disabling network
access revokes existing sessions. Credentials created by older releases that
do not meet the current minimum must be reset from the local app.

### Multi-Device Hub
Register other machines and control them from one Cogpit window. A device switcher in the header (and at the top of the mobile UI) lets you jump between "This machine" and any registered remote — with `⌘⇧1–9` / `Ctrl+Shift+1–9` to jump and `⌘⇧0` to cycle. You always see one machine at a time; switching restores exactly where you left off on that device. Your browser never leaves the hub, which reverse-proxies traffic to each device so there's nothing to configure per-origin.

A device is addable if it runs either the full Cogpit app with Network Access enabled, or the headless `cogpit-server`. Add one from **Devices → Add device** by entering its `host:port` (or `https://host:port` for TLS-terminating proxies) and credentials: a network password for personal edition, or a username and password for team edition. A live probe reports reachability, required authentication, incomplete team bootstrap, disabled network access, and version skew. Actions that only make sense on the machine you're sitting at (open-in-editor, reveal-in-folder, open-terminal) are hidden when a remote device is active — except open-in-editor when **Open files in Cogpit** is enabled, which reads the remote device's files through the hub proxy.

Headless boxes become addable with one command:
```bash
COGPIT_HOST=0.0.0.0 COGPIT_NETWORK_PASSWORD='your-long-passphrase' bun server/standalone.ts
```
The password is read from the environment only (never written to disk); `cogpit-server` refuses to bind to a non-loopback address without one. Set `COGPIT_DEVICE_NAME` to label the device in the switcher, or pass the password via `COGPIT_NETWORK_PASSWORD_FILE` (e.g. systemd `LoadCredential`). On start it prints the exact `host:port` to enter in the hub.

When a TLS reverse proxy connects to Cogpit over loopback, it must add a
standard forwarding header (`Forwarded` or `X-Forwarded-For`; the usual Caddy
and nginx proxy presets do this). Proxied traffic is then treated as remote and
must use the normal network password/session token. Do not strip every
forwarding header while also rewriting `Host` to `localhost`, because that makes
the proxy hop indistinguishable from a direct local client.

### Theming
Dark, Deep OLED, and Light themes use bundled Geist fonts, neutral shadcn tokens, compact radii, and semantic color for status, warnings, and diffs.

## Getting Started

### Without installing

Run the full local web app directly from npm:

```bash
npx cogpit@latest
```

Or open one existing Claude Code, Codex, or Copilot session in a focused chat-only view:

```bash
npx cogpit@latest preview <session-id>
```

Both commands start a loopback-only Cogpit server on an available port, open
your browser, and read session history from the provider directories already
on your machine. Nothing is uploaded. Press `Ctrl+C` to stop the server.

### From Releases (recommended)

Download from the [Releases page](https://github.com/gentritbiba/cogpit/releases) and open.

### From Source

```bash
git clone https://github.com/gentritbiba/cogpit.git
cd cogpit
bun install

# Browser
bun run dev

# Electron
bun run electron:dev
```

### Build

```bash
# Web
bun run build && bun run preview

# Desktop — arm64 macOS DMG, unsigned. ~1 min, for local iteration.
# Release artifacts for every platform are built by .github/workflows/release.yml
bun run electron:package

# Same, but signs with a local Developer ID and builds every host target.
# Only useful with a paid Apple Developer account.
bun run electron:package:signed
```

## Tech Stack

React 19 · TypeScript · Vite 6 · Electron 41 · Tailwind CSS 4 · shadcn/ui · Base UI · Express 5 · SSE + WebSocket · Shiki · Vitest

## License

MIT

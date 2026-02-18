# Cogpit

A real-time dashboard for browsing, inspecting, and interacting with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agent sessions. Available as a **desktop app** (macOS, Windows, Linux) or a **browser-based** dev server.

Cogpit reads the JSONL session files that Claude Code writes to `~/.claude/projects/` and presents them as a rich, interactive UI — with live streaming, conversation timelines, token analytics, undo/redo with branching, team dashboards, and the ability to chat with running sessions.

## Download

Grab the latest release for your platform from the [Releases page](https://github.com/gentritbiba/cogpit/releases):

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `Cogpit-x.x.x-arm64.dmg` |
| macOS (Intel) | `Cogpit-x.x.x.dmg` |
| Windows | `Cogpit-x.x.x-Setup.exe` |
| Linux (AppImage) | `Cogpit-x.x.x.AppImage` |
| Linux (Debian/Ubuntu) | `Cogpit-x.x.x.deb` |
| Linux (Arch) | `Cogpit-x.x.x.pacman` |

> **Requirement:** You need [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed on your machine. Cogpit uses your existing Claude CLI — no separate login or API key needed.

## Features

### Session Browser
Browse all your Claude Code projects and sessions from a sidebar navigator. Sessions are grouped by project directory, sorted by recency, and show live status indicators for active sessions.

### Conversation Timeline
Every session is rendered as a structured conversation with:
- **User messages** — including image attachments
- **Thinking blocks** — expandable extended thinking with signature verification
- **Assistant text** — rendered Markdown with syntax highlighting (via Shiki)
- **Tool calls** — Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch, Task, and more
- **Edit diffs** — visual before/after diffs for Edit tool calls
- **Sub-agent activity** — nested agent spawns and their results
- **Chronological ordering** — content blocks preserve actual execution order

Turn lists with 30+ entries are automatically virtualized for smooth scrolling.

### Live Streaming
Connect to active sessions via Server-Sent Events. New turns appear in real-time as Claude works, with `requestAnimationFrame` throttling to coalesce rapid updates into smooth renders.

### Chat Interface
Send messages to running Claude Code sessions directly from the dashboard:
- Model override per message (Opus, Sonnet, Haiku)
- Voice input powered by Whisper WASM (Ctrl+Shift+M)
- Interrupt running sessions
- Permission-aware message sending
- Pending message status tracking

### Token Analytics & Cost Tracking
A stats panel breaks down every session:
- **Per-turn token usage** — input, output, cache creation, cache read
- **Cost calculation** — model-aware pricing across Opus, Sonnet, and Haiku variants
- **SVG bar chart** — visual token usage per turn
- **Tool call breakdown** — count by tool type
- **Context window usage** — percentage of model limit consumed
- **Error tracking** — count of failed tool calls
- **Duration metrics** — total session time and per-turn timing

### Undo / Redo with Branching
Rewind any session to a previous turn, with full branching support:
- Create branches from any point in the conversation
- Switch between branches via a branch modal
- File operations (Edit/Write) are reversed on undo and replayed on redo
- Nested branches are preserved when a parent is archived
- Confirmation dialog shows exactly what will change before applying

### Team Dashboards
Inspect multi-agent team workflows:
- **Members grid** — visual cards showing team member status
- **Task board** — kanban-style view of pending, in-progress, and completed tasks
- **Message timeline** — color-coded inter-agent communication
- **Live updates** — SSE-based real-time team state
- **Session switching** — jump directly to any team member's session

### Permissions Management
Configure how the dashboard interacts with Claude Code:
- Permission modes: `bypassPermissions`, `default`, `plan`, `acceptEdits`, `dontAsk`, `delegate`
- Tool allowlist / blocklist
- Visual permission configuration panel

### Network Access
Access Cogpit from other devices on your local network:
- **Opt-in** — enable via the settings dialog with a password
- **Password-protected** — remote clients see a login screen before accessing the dashboard
- **Connection URL** — displayed in the header bar, click to copy
- **Full access** — remote clients get the same capabilities as local (chat, undo/redo, teams, etc.)
- **Requires restart** — changing network settings takes effect after restarting the app

The server binds to `0.0.0.0:19384` when network access is enabled. Local clients (localhost) bypass authentication entirely.

### File Changes Panel
Track all file modifications in a session — shows Edit and Write operations with a resizable split-pane view.

### Responsive Layout
Full desktop and mobile support with distinct layouts:

**Desktop:**
```
+------------------+--------------------+--------------+
| Session Browser  |    Chat Area       | Stats Panel  |
| (collapsible)    |    + Timeline      | + Permissions|
|                  |    + Chat Input    | + Servers    |
+------------------+--------------------+--------------+
```

**Mobile:**
```
+----------------------------------------+
| Mobile Header                          |
+----------------------------------------+
| Tab: Sessions | Chat | Stats | Teams  |
+----------------------------------------+
| Active tab content                     |
+----------------------------------------+
```

### Keyboard Shortcuts

Navigate live sessions and control the dashboard from your keyboard:

| Shortcut | Action |
|----------|--------|
| **Ctrl+Shift+1–9** | Jump to the Nth live session |
| **Ctrl+Shift+↑ / ↓** | Navigate between live sessions |
| **Ctrl+B** | Toggle sidebar |
| **Ctrl+Shift+M** | Toggle voice input |
| **Ctrl+E** | Expand all turns |
| **Ctrl+Shift+E** | Collapse all turns |
| **Esc** | Clear search |

On macOS, use **⌘** instead of Ctrl. A shortcuts reference is also shown at the bottom of the dashboard.

## Tech Stack

| Layer | Technology |
|-------|------------|
| UI | React 19, TypeScript 5.6 |
| Build | Vite 6 with React Compiler |
| Desktop | Electron (electron-vite + electron-builder) |
| Styling | Tailwind CSS 4 |
| Components | Radix UI (headless primitives) |
| Icons | Lucide React |
| Syntax highlighting | Shiki |
| Virtualization | @tanstack/react-virtual |
| Markdown | react-markdown |
| Layout | react-resizable-panels |
| Backend | Express 5 (Electron) / Vite plugins (dev) |
| Real-time | Server-Sent Events (SSE) + WebSocket |
| Terminal | node-pty (pseudo-terminal) |
| Voice transcription | whisper-web-transcriber (WASM) |

## Getting Started

### Desktop App (recommended)

Download the installer for your platform from the [Releases page](https://github.com/gentritbiba/cogpit/releases) and open it. On first launch, Cogpit will ask you to confirm the path to your `.claude` directory.

### From Source

#### Prerequisites

- [Bun](https://bun.sh/) (or Node.js 18+)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and used at least once (so `~/.claude/projects/` exists)

#### Install

```bash
git clone https://github.com/gentritbiba/cogpit.git
cd cogpit
bun install
```

#### Run (browser)

```bash
bun run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

#### Run (Electron)

```bash
bun run electron:dev
```

#### Build (web)

```bash
bun run build
bun run preview
```

#### Build (Electron)

```bash
bun run electron:package
```

Outputs to `release/` — produces a DMG on macOS, NSIS installer on Windows, AppImage + deb on Linux.

#### Lint & Type Check

```bash
bun run lint
bun run typecheck
```

## Configuration

On first launch, Cogpit shows a setup screen to configure the path to your `.claude` directory (defaults to `~/.claude`). In the desktop app, the configuration is stored in the system's app data directory. In the web version, it's saved to `config.local.json` at the project root. Both can be changed later via the settings dialog.

The configured directory must contain a `projects/` subdirectory where Claude Code stores session files.

**Network access** can be enabled in the settings dialog by toggling "Network Access" on and setting a password. Remote devices on the same LAN can then connect to `http://<your-ip>:19384` and authenticate with the password. The connection URL is shown in the app header. Changing network settings requires an app restart.

## How It Works

### Architecture

Cogpit ships as two targets from a single codebase:

- **Web** — `bun run dev` starts a Vite dev server with custom plugins that serve the API and PTY WebSocket alongside the frontend.
- **Desktop** — `bun run electron:dev` starts an Electron app with an embedded Express server that imports the same shared route modules. The frontend is loaded from the Express server, which proxies to Vite for HMR during development.

The API routes live in `server/routes/` as small, independent modules. Both the Vite plugin and the Express server register them via the same `register*Routes(use)` interface — no code duplication.

### Session Parsing

Claude Code writes conversation data as JSONL (JSON Lines) files in `~/.claude/projects/<project>/`. Cogpit parses these files into structured sessions:

1. **Load** — Reads the JSONL file line by line
2. **Parse** — Converts raw JSON messages into typed `Turn` objects
3. **Order** — Preserves chronological order of thinking, text, and tool calls within each turn
4. **Aggregate** — Computes session-level statistics (tokens, costs, errors, duration)

For live sessions, an incremental `parseSessionAppend` function efficiently rebuilds only from the last turn boundary — avoiding full re-parses on every SSE update.

### API Layer

Cogpit exposes REST + SSE endpoints (via Vite plugin in dev, Express in Electron):

| Endpoint | Description |
|----------|-------------|
| `GET /api/projects` | List all projects |
| `GET /api/projects/:dir` | List sessions in a project |
| `GET /api/sessions/:dir/:file` | Load a session's JSONL data |
| `GET /api/watch/:dir/:file` | SSE stream for live session updates |
| `POST /api/send-message` | Send a message to a running session |
| `POST /api/undo` | Apply undo (truncate JSONL + reverse file ops) |
| `POST /api/redo` | Apply redo (rewrite JSONL + replay file ops) |
| `GET /api/teams` | List all teams |
| `GET /api/team-detail/:name` | Get team config, tasks, and inbox |
| `GET /api/watch-team/:name` | SSE stream for team updates |
| `GET /api/config` | Get current configuration |
| `POST /api/config` | Save configuration |
| `GET /api/network-info` | Get network access status and LAN URL |
| `POST /api/auth/verify` | Verify password for remote clients |

### Real-Time Updates

- **Session streaming** — SSE connections watch JSONL files for changes via `fs.watch`, pushing new lines to connected clients
- **Team updates** — SSE watches team config, task, and inbox directories
- **Throttling** — Client coalesces rapid updates using `requestAnimationFrame` with a 100ms max latency cap

## Project Structure

```
cogpit/
├── electron/
│   ├── main.ts                            # Electron main process
│   ├── server.ts                          # Embedded Express server + PTY
│   └── preload.ts                         # Preload script (sandboxed)
├── src/
│   ├── App.tsx                            # Root component & layout orchestration
│   ├── main.tsx                           # React entry point
│   ├── index.css                          # Tailwind config & global styles
│   ├── components/
│   │   ├── ConversationTimeline.tsx       # Virtualized turn list
│   │   ├── ChatArea.tsx                   # Chat display + controls
│   │   ├── ChatInput.tsx                  # Message composer
│   │   ├── SessionBrowser.tsx             # Sidebar session navigator
│   │   ├── StatsPanel.tsx                 # Token chart & analytics
│   │   ├── FileChangesPanel.tsx           # File modification tracker
│   │   ├── TeamsDashboard.tsx             # Team overview
│   │   ├── Dashboard.tsx                  # Project/session grid
│   │   ├── PermissionsPanel.tsx           # Permission configuration
│   │   ├── BranchModal.tsx                # Branch switcher
│   │   ├── UndoConfirmDialog.tsx          # Undo confirmation
│   │   ├── ServerPanel.tsx                # Active server processes
│   │   ├── SetupScreen.tsx                # First-run configuration
│   │   ├── LoginScreen.tsx                # Remote client password entry
│   │   ├── DesktopHeader.tsx              # Title bar (draggable in Electron)
│   │   ├── timeline/                      # Turn rendering components
│   │   └── teams/                         # Team dashboard components
│   ├── hooks/                             # React hooks (state, SSE, undo, etc.)
│   ├── lib/
│   │   ├── auth.ts                        # Network auth (authFetch, authUrl, token mgmt)
│   │   └── ...                            # Types, parser, formatters, utils
├── server/
│   ├── api-plugin.ts                      # Vite plugin wrapper
│   ├── pty-plugin.ts                      # Vite plugin: WebSocket PTY
│   ├── config.ts                          # Config file I/O
│   ├── helpers.ts                         # Shared state & utilities
│   └── routes/                            # API route modules (12 files)
│       ├── config.ts
│       ├── projects.ts
│       ├── claude.ts
│       ├── claude-new.ts
│       ├── claude-manage.ts
│       ├── ports.ts
│       ├── teams.ts
│       ├── team-session.ts
│       ├── undo.ts
│       ├── files.ts
│       └── files-watch.ts
├── .github/workflows/release.yml          # CI: build + publish releases
├── electron.vite.config.ts                # Electron build config
├── electron-builder.yml                   # Packaging config (all platforms)
├── vite.config.ts
└── package.json
```

## License

MIT

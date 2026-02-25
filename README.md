# Cogpit
<img width="2056" height="1292" alt="image" src="https://github.com/user-attachments/assets/9c47d9db-772c-46f4-8cbf-97d68dd76e38" />



**[cogpit.gentrit.dev](https://cogpit.gentrit.dev/)**

A real-time dashboard for browsing, inspecting, and interacting with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agent sessions. Available as a **desktop app** (macOS, Linux) or a **browser-based** dev server.

Cogpit reads the JSONL session files that Claude Code writes to `~/.claude/projects/` and presents them as a rich, interactive UI — with live streaming, conversation timelines, token analytics, undo/redo with branching, team dashboards, and the ability to chat with running sessions.

## Download

Grab the latest release for your platform from the [Releases page](https://github.com/gentritbiba/cogpit/releases):

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `Cogpit-x.x.x-arm64.dmg` |
| macOS (Intel) | `Cogpit-x.x.x.dmg` |
| Linux (AppImage) | `Cogpit-x.x.x.AppImage` |
| Linux (Debian/Ubuntu) | `Cogpit-x.x.x.deb` |
| Linux (Arch) | `Cogpit-x.x.x.pacman` |

> **Requirement:** You need [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed on your machine. Cogpit uses your existing Claude CLI — no separate login or API key needed.

## Features

### Session Browser
Browse all your Claude Code projects and sessions from a sidebar navigator. Sessions are grouped by project directory, sorted by recency, and show live status indicators for active sessions.

- **Live sessions panel** — running sessions with status dots (green=running, amber=completed, gray=idle), RAM usage tooltips, and a kill button on hover
- **Process monitor** — lists all system-wide `claude` processes with PID, memory, and CPU usage; detects orphaned processes not linked to any session
- **Session cards** — model badge, turn count, git branch, file size, first message preview, and relative timestamps
- **Search & filter** — debounced search across sessions and projects
- **Pagination** — "Load more" for large project histories
- **MRU session switching** — Ctrl+Tab / Ctrl+Shift+Tab cycles through recently used sessions (Firefox-style)
- **Jump to session** — Ctrl+Shift+1–9 jumps directly to the Nth live session
- **Context menus** — right-click to duplicate or delete sessions (with confirmation)

### Conversation Timeline
Every session is rendered as a structured conversation with:
- **User messages** — including image attachments, expandable long text (truncated at 500 chars), and system tag stripping
- **Thinking blocks** — expandable extended thinking sections, multiple blocks per turn
- **Assistant text** — rendered Markdown with syntax highlighting (via Shiki), model badge, and per-response token usage tooltip
- **Tool calls** — color-coded badges (Read=blue, Write=green, Edit=amber, Bash=red, Grep=purple, Glob=cyan, Task=indigo, WebFetch=orange, AskUserQuestion=pink), expandable input/output, status indicators (success/error/in-progress)
- **Edit diffs** — LCS-based line-by-line diffs with syntax highlighting, green/red additions/removals, line numbers, and full-screen expansion
- **Sub-agent activity** — color-coded panels (5-color palette) showing nested agent thinking, text, and tool calls
- **Background agent activity** — separate violet-themed panels for background agents
- **Compaction markers** — collapsible indicators when context was compressed
- **Chronological ordering** — content blocks preserve actual execution order

Turn lists with 30+ entries are automatically virtualized for smooth scrolling.

**Full-text search** filters across user messages, assistant text, thinking blocks, tool names, and tool input/output — all case-insensitive and in real-time.

**Sticky prompt banner** — when you scroll past a turn's user message, a sticky header shows the prompt so you always know which turn you're reading.

### Live Streaming
Connect to active sessions via Server-Sent Events. New turns appear in real-time as Claude works, with `requestAnimationFrame` throttling to coalesce rapid updates into smooth renders. Connection state tracking (connecting/connected/disconnected) with 30-second stale detection and automatic reconnection.

### Chat Interface
Send messages to running Claude Code sessions directly from the dashboard:
- **Model override** per message (Opus, Sonnet, Haiku)
- **Voice input** powered by Whisper WASM — real-time transcription with progress indicator while the model loads (Ctrl+Shift+M)
- **Slash command suggestions** — type `/` to get command and skill suggestions scanned from project `.claude/` directory, user skills, and installed plugins; keyboard navigation with arrow keys, Tab, and Enter
- **Image support** — drag-and-drop, paste from clipboard, or attach files; preview strip with remove buttons, click to expand full-screen; auto-converts unsupported formats (e.g. TIFF → PNG)
- **Plan approval bar** — when the agent enters plan mode, approve or reject with listed permission requests
- **User question bar** — multiple-choice options with descriptions when the agent asks a question; supports multi-select
- **Interrupt / stop** — interrupt a running response or kill the session process entirely
- **Permission-aware** sending with configurable tool access
- **Pending message** status tracking with elapsed time counter
- **Auto-expanding textarea** with Shift+Enter for newlines

### Token Analytics & Cost Tracking
A stats panel breaks down every session:
- **Per-turn token usage** — input, output, cache creation, cache read
- **Cost calculation** — model-aware pricing across Opus, Sonnet, and Haiku variants
- **SVG bar chart** — visual token usage per turn
- **Tool call breakdown** — count by tool type
- **Context window usage** — percentage of model limit consumed with color coding (green → yellow → orange → red)
- **Error tracking** — count of failed tool calls with red highlighting
- **Duration metrics** — total session time and per-turn timing
- **Agent breakdown** — main agent vs sub-agents, with separate token counts
- **Model breakdown** — for multi-model sessions, token usage per model
- **Cache efficiency** — stacked bar chart showing cache hit rates
- **API rate limit widget** — 5-hour and 7-day utilization with color-coded percentages, time-to-reset, and subscription type badge

### Undo / Redo with Branching
Rewind any session to a previous turn, with full branching support:
- Create branches from any point in the conversation
- Switch between branches via a branch modal with SVG graph visualization
- File operations (Edit/Write) are reversed on undo and replayed on redo
- Nested branches are preserved when a parent is archived
- Redo all archived turns at once, or partially redo up to a specific turn
- Ghost turns show archived content with hover-to-redo
- Confirmation dialog shows exactly what will change before applying

### Team Dashboards
Inspect multi-agent team workflows:
- **Members grid** — visual cards showing team member status with color coding
- **Task board** — kanban-style view of pending, in-progress, and completed tasks
- **Message timeline** — color-coded inter-agent communication
- **Team chat** — send messages to individual team members with a member selector dropdown
- **Live updates** — SSE-based real-time team state via file watching
- **Session switching** — jump directly to any team member's session

### Permissions Management
Configure how the dashboard interacts with Claude Code:
- Permission modes: `bypassPermissions`, `default`, `plan`, `acceptEdits`, `dontAsk`, `delegate`
- Tool-level allow/block grid — left-click to allow, right-click to block (Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, NotebookEdit, Task)
- Pending changes indicator — applies on next message without interrupting the current session
- Reset to defaults

### Theming
Three built-in themes with a Malewicz-inspired elevation system:
- **Dark** — blue-tinted OKLCH dark mode (default)
- **Deep OLED** — true black backgrounds for OLED displays
- **Light** — clean light mode with high contrast

Each theme uses 5 elevation levels for depth perception, hue-matched shadows (blue-tinted, never pure black), glassmorphism effects, and gradient borders. Live preview while selecting themes via Ctrl+Alt+S. Respects `prefers-reduced-motion`.

### Worktree Management
A dedicated panel for managing git worktrees created during Claude Code sessions:
- List all active worktrees with dirty/clean status indicators
- Commits-ahead count and linked session tracking
- Create pull requests directly from worktrees via `gh pr create`
- Delete worktrees (with optional force flag)
- Bulk cleanup of stale worktrees (older than 7 days, no uncommitted changes)

### Server & Task Output
Monitor running dev servers and background tasks spawned by the agent:
- Real-time SSE streaming of server output
- ANSI escape code stripping for clean display
- Auto-scrolling with connection status indicator
- Port detection and management — check which ports are listening, kill processes on specific ports
- Background task scanning with detected ports

### Editor & OS Integration
Open files, folders, and terminals from anywhere in the dashboard:
- **Open in editor** — opens files or folders in your default code editor (supports VS Code and Cursor diff mode)
- **Reveal in Finder** — opens the OS file manager at the file's location
- **Open terminal** — launches a terminal at the session's working directory (Ctrl+Alt+T); auto-detects Ghostty, iTerm, Warp, Alacritty, kitty on macOS, or set a custom terminal in settings
- **Copy resume command** — copies the `claude --resume` command for any session

### Todo Progress Tracking
When Claude uses the TodoWrite tool, Cogpit extracts task progress and displays it as a sticky banner:
- Progress bar with completion percentage (blue → green at 100%)
- Currently active task with spinner
- Collapsible full task list with individual status indicators (pending/in-progress/completed)

### Network Access
Access Cogpit from other devices on your local network:
- **Opt-in** — enable via the settings dialog with a password (minimum 12 characters)
- **Password-protected** — remote clients see a login screen with rate-limited authentication (5 attempts/minute)
- **Connected devices** — displays active remote sessions with device type icons (phone/tablet/desktop), IP address, and last activity
- **Connection URL** — displayed in the header bar, click to copy
- **Full access** — remote clients get the same capabilities as local (chat, undo/redo, teams, etc.)
- **Requires restart** — changing network settings takes effect after restarting the app

The server binds to `0.0.0.0:19384` when network access is enabled. Local clients (localhost) bypass authentication entirely.

### File Changes Panel
Track all file modifications in a session — shows Edit and Write operations with +/- line counts, deleted file tracking, and a resizable split-pane view. Click any file to open it in your editor.

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

Touch-friendly with 44px minimum tap targets, momentum scrolling, and single-column layouts.

### Keyboard Shortcuts

Navigate live sessions and control the dashboard from your keyboard:

| Shortcut | Action |
|----------|--------|
| **Space** | Focus chat input |
| **Ctrl+B** | Toggle sidebar |
| **Ctrl+E** | Expand all turns |
| **Ctrl+Shift+E** | Collapse all turns |
| **Ctrl+Shift+M** | Toggle voice input |
| **Ctrl+Tab** / **Ctrl+Shift+Tab** | Cycle through recent sessions (MRU) |
| **Ctrl+Shift+1–9** | Jump to the Nth live session |
| **Ctrl+Shift+↑ / ↓** | Navigate between live sessions |
| **Ctrl+Cmd+N** (macOS) / **Ctrl+Alt+N** (Linux) | Open project switcher |
| **Ctrl+Cmd+S** (macOS) / **Ctrl+Alt+S** (Linux) | Open theme selector |
| **Ctrl+Cmd+T** (macOS) / **Ctrl+Alt+T** (Linux) | Open terminal in session directory |
| **Esc** | Clear search / interrupt agent |

On macOS, use **⌘** instead of Ctrl. A shortcuts reference is also shown at the bottom of the dashboard.

## Tech Stack

| Layer | Technology |
|-------|------------|
| UI | React 19, TypeScript 5.6 |
| Build | Vite 6 with React Compiler |
| Desktop | Electron 40 (electron-vite + electron-builder) |
| Styling | Tailwind CSS 4 |
| Components | Radix UI (headless primitives) |
| Icons | Lucide React |
| Syntax highlighting | Shiki |
| Virtualization | @tanstack/react-virtual |
| Markdown | react-markdown + remark-gfm |
| Layout | react-resizable-panels |
| Backend | Express 5 (Electron) / Vite plugins (dev) |
| Real-time | Server-Sent Events (SSE) + WebSocket |
| Terminal | node-pty (pseudo-terminal) |
| Voice transcription | whisper-web-transcriber (WASM) |
| Testing | Vitest + Testing Library |

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

Outputs to `release/` — produces a DMG on macOS, AppImage + deb on Linux.

#### Lint & Type Check

```bash
bun run lint
bun run typecheck
```

#### Tests

```bash
bun run test
bun run test:watch
bun run test:coverage
```

## Configuration

On first launch, Cogpit shows a setup screen to configure the path to your `.claude` directory (defaults to `~/.claude`). In the desktop app, the configuration is stored in the system's app data directory. In the web version, it's saved to `config.local.json` at the project root. Both can be changed later via the settings dialog.

The configured directory must contain a `projects/` subdirectory where Claude Code stores session files.

**Terminal application** can be customized via the settings dialog. By default, the open-terminal shortcut auto-detects the running terminal on macOS (Ghostty, iTerm, Warp, Alacritty, kitty) and falls back to Terminal.app. You can override this by setting a custom terminal application name or path in the `Terminal Application` field.

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

Cogpit exposes 30+ REST + SSE endpoints (via Vite plugin in dev, Express in Electron):

| Endpoint | Description |
|----------|-------------|
| `GET /api/projects` | List all projects |
| `GET /api/sessions/:dir` | List sessions in a project (paginated) |
| `GET /api/sessions/:dir/:file` | Load a session's JSONL data |
| `GET /api/active-sessions` | List recent sessions across all projects (searchable) |
| `GET /api/find-session/:id` | Locate a session file by ID |
| `GET /api/watch/:dir/:file` | SSE stream for live session updates |
| `POST /api/send-message` | Send a message to a running session |
| `POST /api/new-session` | Create a new Claude session |
| `POST /api/create-and-send` | Create session and send first message atomically |
| `POST /api/branch-session` | Branch/fork a session at a turn |
| `POST /api/stop-session` | Stop a running Claude process |
| `POST /api/kill-all` | Kill all active Claude processes |
| `POST /api/delete-session` | Kill process and delete session JSONL |
| `GET /api/running-processes` | List all system `claude` processes with PID/memory/CPU |
| `POST /api/undo/apply` | Apply batch file operations with rollback |
| `POST /api/undo/truncate-jsonl` | Truncate JSONL for undo |
| `POST /api/undo/append-jsonl` | Append JSONL lines for redo |
| `GET /api/teams` | List all teams with task progress |
| `GET /api/team-detail/:name` | Full team config, tasks, and inboxes |
| `GET /api/team-watch/:name` | SSE stream for team updates |
| `POST /api/team-message/:name/:member` | Send message to team member |
| `GET /api/worktrees/:dir` | List worktrees with status and linked sessions |
| `DELETE /api/worktrees/:dir/:name` | Remove a worktree |
| `POST /api/worktrees/:dir/create-pr` | Create PR from worktree |
| `GET /api/session-file-changes/:id` | Parse all file modifications in a session |
| `GET /api/check-ports` | Check which ports are listening |
| `GET /api/background-tasks` | Scan for background bash tasks |
| `GET /api/background-agents` | Find background agent sessions |
| `GET /api/slash-suggestions` | Scan for commands and skills |
| `POST /api/expand-command` | Expand a slash command file |
| `GET /api/usage` | Fetch Claude API usage stats |
| `POST /api/reveal-in-folder` | Open OS file manager |
| `POST /api/open-terminal` | Open terminal at directory |
| `POST /api/open-in-editor` | Open file/folder in code editor |
| `GET /api/config` | Get current configuration |
| `POST /api/config` | Save configuration |
| `GET /api/network-info` | Get network access status and LAN URL |
| `POST /api/auth/verify` | Verify password for remote clients |
| `GET /api/connected-devices` | List active remote device sessions |

### Real-Time Updates

- **Session streaming** — SSE connections watch JSONL files for changes via `fs.watch`, pushing new lines to connected clients
- **Subagent synthesis** — When Claude spawns subagents via the Task tool, their JSONL output is monitored separately and synthesized as `agent_progress` entries into the parent session JSONL
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
│   │   ├── ChatInput.tsx                  # Message composer + slash suggestions
│   │   ├── SessionBrowser.tsx             # Sidebar session navigator
│   │   ├── LiveSessions.tsx              # Running sessions + process monitor
│   │   ├── StatsPanel.tsx                 # Token chart & analytics
│   │   ├── FileChangesPanel.tsx           # File modification tracker
│   │   ├── WorktreePanel.tsx             # Git worktree management
│   │   ├── ServerPanel.tsx               # Dev server output streaming
│   │   ├── TodoProgressPanel.tsx         # Task progress tracking
│   │   ├── TeamsDashboard.tsx             # Team overview
│   │   ├── Dashboard.tsx                  # Project/session grid
│   │   ├── PermissionsPanel.tsx           # Permission configuration
│   │   ├── BranchModal.tsx                # Branch switcher with SVG graph
│   │   ├── ThemeSelectorModal.tsx        # Theme picker with live preview
│   │   ├── ProjectSwitcherModal.tsx      # Quick project switching
│   │   ├── TokenUsageWidget.tsx          # API rate limit indicator
│   │   ├── SlashSuggestions.tsx           # Command/skill autocomplete
│   │   ├── UndoConfirmDialog.tsx          # Undo confirmation
│   │   ├── SetupScreen.tsx                # First-run configuration
│   │   ├── LoginScreen.tsx                # Remote client password entry
│   │   ├── DesktopHeader.tsx              # Title bar (draggable in Electron)
│   │   ├── timeline/                      # Turn rendering components
│   │   ├── teams/                         # Team dashboard components
│   │   └── ui/                            # Radix UI wrapper components
│   ├── hooks/                             # 26 custom React hooks
│   └── lib/                               # Types, parser, auth, formatters, utils
├── server/
│   ├── api-plugin.ts                      # Vite plugin wrapper
│   ├── pty-plugin.ts                      # Vite plugin: WebSocket PTY
│   ├── config.ts                          # Config file I/O
│   ├── helpers.ts                         # Shared state & utilities
│   └── routes/                            # API route modules
│       ├── config.ts                      # Configuration & auth
│       ├── projects.ts                    # Project & session listing
│       ├── claude.ts                      # Send messages to sessions
│       ├── claude-new.ts                  # New sessions & branching
│       ├── claude-manage.ts               # Stop/kill/delete sessions
│       ├── ports.ts                       # Port monitoring & background tasks
│       ├── teams.ts                       # Team management & live updates
│       ├── team-session.ts                # Team session detection
│       ├── undo.ts                        # Undo/redo operations
│       ├── files.ts                       # File existence checking
│       ├── files-watch.ts                 # SSE streaming for sessions
│       ├── session-file-changes.ts        # File change analysis
│       ├── editor.ts                      # Editor & OS integration
│       ├── worktrees.ts                   # Git worktree management
│       ├── usage.ts                       # API usage stats
│       └── slash-suggestions.ts           # Command/skill scanning
├── .github/workflows/release.yml          # CI: build + publish releases
├── electron.vite.config.ts                # Electron build config
├── electron-builder.yml                   # Packaging config (all platforms)
├── vite.config.ts
└── package.json
```

## License

MIT

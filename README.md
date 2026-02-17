# Cogpit

A real-time dashboard for browsing, inspecting, and interacting with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agent sessions.

Cogpit reads the JSONL session files that Claude Code writes to `~/.claude/projects/` and presents them as a rich, interactive UI — with live streaming, conversation timelines, token analytics, undo/redo with branching, team dashboards, and the ability to chat with running sessions.

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
- Interrupt running sessions
- Kill all active sessions
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

## Tech Stack

| Layer | Technology |
|-------|------------|
| UI | React 19, TypeScript 5.6 |
| Build | Vite 6 with React Compiler |
| Styling | Tailwind CSS 4 |
| Components | Radix UI (headless primitives) |
| Icons | Lucide React |
| Syntax highlighting | Shiki |
| Virtualization | @tanstack/react-virtual |
| Markdown | react-markdown |
| Layout | react-resizable-panels |
| Backend | Vite dev server with custom plugins |
| Real-time | Server-Sent Events (SSE) + WebSocket |
| Terminal | node-pty (pseudo-terminal) |

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (or Node.js 18+)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and used at least once (so `~/.claude/projects/` exists)

### Install

```bash
git clone <repo-url>
cd cogpit
bun install
```

### Run

```bash
bun run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Build

```bash
bun run build
bun run preview
```

### Lint & Type Check

```bash
bun run lint
bun run typecheck
```

## Configuration

On first launch, Cogpit shows a setup screen to configure the path to your `.claude` directory (defaults to `~/.claude`). The configuration is saved to `config.local.json` at the project root and can be changed later via the settings dialog.

The configured directory must contain a `projects/` subdirectory where Claude Code stores session files.

## How It Works

### Session Parsing

Claude Code writes conversation data as JSONL (JSON Lines) files in `~/.claude/projects/<project>/`. Cogpit parses these files into structured sessions:

1. **Load** — Reads the JSONL file line by line
2. **Parse** — Converts raw JSON messages into typed `Turn` objects
3. **Order** — Preserves chronological order of thinking, text, and tool calls within each turn
4. **Aggregate** — Computes session-level statistics (tokens, costs, errors, duration)

For live sessions, an incremental `parseSessionAppend` function efficiently rebuilds only from the last turn boundary — avoiding full re-parses on every SSE update.

### API Layer

Cogpit runs a custom Vite plugin that exposes REST + SSE endpoints:

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

### Real-Time Updates

- **Session streaming** — SSE connections watch JSONL files for changes via `fs.watch`, pushing new lines to connected clients
- **Team updates** — SSE watches team config, task, and inbox directories
- **Throttling** — Client coalesces rapid updates using `requestAnimationFrame` with a 100ms max latency cap

## Project Structure

```
cogpit/
├── src/
│   ├── App.tsx                          # Root component & layout orchestration
│   ├── main.tsx                         # React entry point
│   ├── index.css                        # Tailwind config & global styles
│   ├── components/
│   │   ├── ConversationTimeline.tsx     # Virtualized turn list
│   │   ├── ChatArea.tsx                 # Chat display + controls
│   │   ├── ChatInput.tsx                # Message composer
│   │   ├── SessionBrowser.tsx           # Sidebar session navigator
│   │   ├── StatsPanel.tsx               # Token chart & analytics
│   │   ├── FileChangesPanel.tsx         # File modification tracker
│   │   ├── TeamsDashboard.tsx           # Team overview
│   │   ├── Dashboard.tsx                # Project/session grid
│   │   ├── PermissionsPanel.tsx         # Permission configuration
│   │   ├── BranchModal.tsx              # Branch switcher
│   │   ├── UndoConfirmDialog.tsx        # Undo confirmation
│   │   ├── ServerPanel.tsx              # Active server processes
│   │   ├── SetupScreen.tsx              # First-run configuration
│   │   ├── timeline/                    # Turn rendering components
│   │   │   ├── UserMessage.tsx
│   │   │   ├── AssistantText.tsx
│   │   │   ├── ThinkingBlock.tsx
│   │   │   ├── ToolCallCard.tsx
│   │   │   ├── EditDiffView.tsx
│   │   │   └── SubAgentPanel.tsx
│   │   ├── teams/                       # Team dashboard components
│   │   │   ├── MembersGrid.tsx
│   │   │   ├── TaskBoard.tsx
│   │   │   └── MessageTimeline.tsx
│   │   └── ui/                          # Radix UI primitive wrappers
│   ├── hooks/
│   │   ├── useSessionState.ts           # Central state reducer
│   │   ├── useLiveSession.ts            # SSE streaming & incremental parsing
│   │   ├── usePtyChat.ts                # Chat message API
│   │   ├── useUndoRedo.ts               # Undo/redo & branching logic
│   │   ├── useSessionActions.ts         # Session load/navigate handlers
│   │   ├── useUrlSync.ts                # Hash-based URL routing
│   │   ├── useSessionTeam.ts            # Team detection for sessions
│   │   ├── usePermissions.ts            # Permission state (localStorage)
│   │   ├── useAppConfig.ts              # Directory configuration
│   │   └── ...                          # Keyboard shortcuts, scroll, etc.
│   └── lib/
│       ├── types.ts                     # TypeScript interfaces
│       ├── team-types.ts                # Team-specific types
│       ├── parser.ts                    # JSONL → ParsedSession pipeline
│       ├── format.ts                    # Token/cost/duration formatters
│       ├── undo-engine.ts               # File operation reversal logic
│       └── permissions.ts               # Permission mode utilities
├── server/
│   ├── api-plugin.ts                    # Vite plugin: REST + SSE API
│   ├── pty-plugin.ts                    # Vite plugin: WebSocket PTY
│   └── config.ts                        # Config file I/O
├── vite.config.ts
├── package.json
├── tsconfig.app.json
└── tsconfig.node.json
```

## License

MIT

# Cogpit Architecture & Agent Integration Guide

## Project Overview

**Cogpit** is a real-time dashboard for monitoring Claude Code agent sessions. It:
- Reads JSONL session files from `~/.claude/projects/`
- Monitors background sub-agents spawned via Task tool calls
- Tracks background servers (dev servers, API servers) running in background Bash commands
- Provides live streaming updates via Server-Sent Events (SSE)
- Offers undo/redo with branching, team dashboards, voice input, and permission management

**Tech Stack:**
- Frontend: React 19, TypeScript 5.6, Vite 6, Tailwind CSS 4, Radix UI, Shiki (syntax highlighting)
- Backend: Express 5 (Electron), Vite plugins (dev), node-pty (pseudo-terminal), WebSocket (live PTY)
- Desktop: Electron 40 with electron-builder, electron-vite
- Package Manager: Bun

---

## App Launch & Execution

### Electron Main Process (`electron/main.ts`)

1. **PATH Resolution** (lines 9-15)
   - GUI apps don't inherit shell PATH; Electron manually spawns shell to capture real PATH
   - Ensures `claude` CLI is discoverable via shell startup scripts
   - Falls back to system PATH if shell invocation fails

2. **Window Creation** (`createWindow()`)
   - Creates BrowserWindow (1400×900, draggable title bar)
   - Loads from Express server at `http://127.0.0.1:{port}`
   - Opens external links in system browser
   - Prevents navigation away from app origin

3. **Server Startup** (`app.whenReady()`)
   - Starts embedded Express server via `createAppServer()`
   - Binds to `0.0.0.0:19384` if network access enabled, otherwise `127.0.0.1`
   - Dynamically allocates port (0 = any available) in production for non-networked mode
   - Grants microphone permission for Whisper WASM voice input
   - Registers custom menu (removes conflicting shortcuts)

### Electron Server (`electron/server.ts`)

The Express server handles:
- **Static file serving** — Built React app
- **API routes** — Registered in `server/routes/*.ts` (see route list below)
- **PTY WebSocket** — Interactive terminal sessions
- **Vite dev proxy** (dev mode) — HMR + live reload

All routes are **dual-registered**:
1. `server/api-plugin.ts` — Vite plugin wrapper (dev: `bun run dev`)
2. `electron/server.ts` — Express server (both: `bun run electron:dev` and built app)

If registered in only one place, the route works in dev but not in production, or vice versa.

---

## How Agents Are Executed & Monitored

### 1. Background Task Spawning (Claude's Task Tool)

When Claude Code calls the Task tool with `run_in_background: true`:
- Task output is written to Claude's task directory: `/private/tmp/claude-{uid}/{projectHash}/tasks/`
- Agent progress is captured as `agent_progress` JSONL entries in the parent session

### 2. Background Agent Detection (`/api/background-agents`)

**Route:** `server/routes/ports.ts` (lines 62+)

Scans `~/.claude/projects/{project}/` for symlinks to running agent sessions:
- Symlinks point to background agent JSONL files
- Extracted data:
  - `agentId`: Unique identifier
  - `dirName`, `fileName`: Session location
  - `parentSessionId`: Which session spawned it
  - `modifiedAt`: Last update timestamp
  - `isActive`: Whether still running
  - `preview`: First few lines of output

**Frontend polling:** `StatsPanel.tsx` line 631
- Polls every 5 seconds while panel is open
- Calls `/api/background-agents?cwd={projectPath}`

### 3. Background Task Monitoring (`/api/background-tasks`)

**Route:** `server/routes/ports.ts` (line 62)

Scans Claude's task output directory for running background Bash tasks:
- File pattern: `{taskId}.output`
- Reads first 8KB to extract:
  - Port numbers (`:3000`, `port 5173`, etc.)
  - Command preview
  - Modification time

**Fallback mechanism:**
- Primary: `/api/background-tasks` queries Claude's task directory
- Fallback: Extract ports from JSONL Bash tool calls, then check with `/api/check-ports`

### 4. Port Checking (`/api/check-ports`)

**Route:** `server/routes/ports.ts` (line 15)

Tests TCP connection to detect listening services:
- Input: `?ports=3000,5173,8000`
- Output: `{ 3000: true, 5173: true, 8000: false }` (JSON)
- Timeout: 500ms per port

Used by StatsPanel → BackgroundServers component to show live status.

### 5. Port Killing (`/api/kill-port`)

**Route:** `server/routes/ports.ts` (lines 154+)

Gracefully terminates process listening on a port:
- Uses `lsof` + `kill` (Unix/macOS)
- Waits for graceful shutdown
- Falls back to `SIGKILL` after 5s

---

## Backend API Routes

All routes are registered in **both** `server/api-plugin.ts` (Vite) and `electron/server.ts` (Express).

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/config` | GET/POST | Configuration (`.claude` path, network settings, terminal app) |
| `/api/projects` | GET | List projects in `.claude/projects/` |
| `/api/projects/:dir` | GET | List sessions in a project (with preview, team info) |
| `/api/sessions/:dir/:file` | GET | Load full JSONL session data |
| `/api/watch/:dir/:file` | GET (SSE) | Live stream for active session |
| `/api/send-message` | POST | Send message to running Claude Code session |
| `/api/undo` | POST | Truncate JSONL to a turn, reverse file edits |
| `/api/redo` | POST | Rewrite JSONL from archived turn, replay file edits |
| `/api/teams` | GET | List teams in `~/.claude/teams/` |
| `/api/team-detail/:name` | GET | Team config, tasks, and inbox |
| `/api/watch-team/:name` | GET (SSE) | Live stream for team updates |
| `/api/check-ports` | GET | Test TCP listening on ports |
| `/api/background-tasks` | GET | Scan Claude's task dir for background Bash tasks |
| `/api/background-agents` | GET | Scan `projects/` for background agent symlinks |
| `/api/kill-port` | POST | Kill process on port |
| `/api/open-terminal` | POST | Launch terminal in project directory |
| `/api/pty` | WS | WebSocket PTY session |
| `/api/ports` | GET | List listening processes (scans lsof) |
| `/api/worktrees` | GET/POST/DELETE | Manage git worktrees |
| `/api/usage` | GET | Token usage tracking |

---

## Data Model: Background Agents

### SubAgentMessage Type (`src/lib/types.ts` lines 157-168)

```typescript
interface SubAgentMessage {
  agentId: string
  type: "user" | "assistant"
  content: unknown
  toolCalls: ToolCall[]
  thinking: string[]
  text: string[]
  timestamp: string
  tokenUsage: TokenUsage | null
  model: string | null
  isBackground: boolean  // ← Set to true for background task agents
}
```

### TurnContentBlock Union (`src/lib/types.ts` lines 171-176)

```typescript
type TurnContentBlock =
  | { kind: "thinking"; blocks: ThinkingBlock[] }
  | { kind: "text"; text: string[] }
  | { kind: "tool_calls"; toolCalls: ToolCall[] }
  | { kind: "sub_agent"; messages: SubAgentMessage[] }
  | { kind: "background_agent"; messages: SubAgentMessage[] }  // ← Separate from sub_agent
```

---

## Session Parsing: Background Agent Detection

### Parser Logic (`src/lib/parser.ts`)

**Track background Task tool calls** (lines 386-390):
```typescript
if (input.run_in_background === true) {
  backgroundAgentParentIds.add(block.id)
}
```

**Tag agent_progress messages** (lines 177-196):
- Check if `parentToolUseID` is in `backgroundAgentParentIds` set
- If true: set `isBackground: true` on SubAgentMessage
- Flush to `kind: "background_agent"` block (not `kind: "sub_agent"`)

**Result:**
- Background agents render separately in UI (violet theme)
- Statistics still roll up to Turn-level counts

---

## UI Component Structure

### Main Layout (`src/App.tsx`)

**Desktop (1400px+):**
```
┌────────────────────────────────────────────┐
│ DesktopHeader (draggable title bar)        │
├──────────────┬──────────────────┬──────────┤
│ SessionBrowser    ConversationTimeline      StatsPanel
│ (search,      (live turns, tool   (tokens, ports,
│  sessions)    calls, branches)    agents, perms)
└──────────────┴──────────────────┴──────────┘
```

**Mobile (<1024px):**
```
┌─────────────────────────┐
│ DesktopHeader           │
├─────────────────────────┤
│ [Active tab content]    │
├─────────────────────────┤
│ MobileNav (tab bar)     │
└─────────────────────────┘
```

### Key Components

#### Background Agent Display (`src/components/StatsPanel.tsx` lines 622-680)

Renders running background agents in the stats panel:
- **RefreshCw icon** — Polling status
- **Agent badges** — Color-coded by index (indigo, cyan, amber, rose, emerald)
- **Click to load** — Opens agent session in main view
- **Poll interval** — 5 seconds

#### Timeline Rendering (`src/components/ConversationTimeline.tsx` line 636)

Dispatches `kind: "background_agent"` blocks to `BackgroundAgentPanel`:
```typescript
if (block.kind === "background_agent") {
  return <BackgroundAgentPanel messages={block.messages} />
}
```

#### Background Agent Panel (`src/components/timeline/BackgroundAgentPanel.tsx`)

- **Violet theme** — Border, text, icons use violet color scheme
- **Structured messages** — Each agent message shows turns, tool calls, tokens
- **Expandable** — Defaults to collapsed; expands with "Expand all turns"
- **Same structure as SubAgentPanel** — Just different color

### Server Monitoring (`StatsPanel.tsx` lines 381-600)

Displays running background servers (dev servers, API servers):
- Scans Claude's task directory for `.output` files with detected ports
- Shows port status (green = listening, gray = stopped)
- Provides "Stop" button to kill on port (via `/api/kill-port`)
- Shows output file link (click to stream in ServerPanel)

---

## Notification System

**Current Implementation:** None exists yet.

The app currently has **no built-in toast/alert system**. Error reporting relies on:
- Browser console (`console.error`, `console.warn`)
- Dialog modals for critical flows (undo confirmation, branch selection)
- Status badges in UI (green/gray for port status)

### Where to Add Notifications

1. **Background agent completion** — When agent exits (subscribe to `agent_progress` with `status: "exited"`)
2. **Port availability** — When a dev server comes online or goes offline
3. **Terminal output** — When long-running background tasks produce errors
4. **API failures** — Network errors, auth failures
5. **Session loading** — Errors parsing JSONL
6. **Undo/Redo actions** — Success/failure of branching operations

### Recommended Approach

Given the current architecture, notifications should be:
- **Minimal & dismissible** — Toast-style in corner (top-right or bottom-right)
- **Color-coded** — Green (success), red (error), yellow (warning), blue (info)
- **Auto-dismiss** — After 5-8 seconds (user can click to keep longer)
- **Non-blocking** — Should not require user action to dismiss
- **Scoped to context** — Show notifications near the component that triggered them

---

## File Organization

```
cogpit/
├── electron/
│   ├── main.ts              # Electron entry point
│   ├── server.ts            # Express server + PTY WebSocket
│   └── preload.ts           # Sandbox preload script
│
├── src/
│   ├── App.tsx              # Root layout component
│   ├── main.tsx             # React entry point
│   ├── index.css            # Tailwind + global styles
│   │
│   ├── components/
│   │   ├── StatsPanel.tsx           # Token chart, ports, agents
│   │   ├── ConversationTimeline.tsx # Turn renderer, dispatcher
│   │   ├── SessionBrowser.tsx       # Project/session navigator
│   │   ├── ChatArea.tsx             # Message display
│   │   ├── ChatInput.tsx            # Message composer
│   │   ├── FileChangesPanel.tsx     # Edit/Write tracker
│   │   ├── TeamsDashboard.tsx       # Team overview
│   │   ├── ServerPanel.tsx          # Server output streaming
│   │   ├── WorktreePanel.tsx        # Git worktree manager
│   │   │
│   │   └── timeline/
│   │       ├── UserMessage.tsx       # User content
│   │       ├── AssistantText.tsx     # Markdown rendering
│   │       ├── ToolCall.tsx          # Tool call renderer
│   │       ├── SubAgentPanel.tsx     # Foreground sub-agent activity
│   │       └── BackgroundAgentPanel.tsx  # Background agent activity (violet)
│   │
│   ├── hooks/
│   │   ├── useLiveSession.ts        # SSE streaming
│   │   ├── useSessionState.ts       # Global session state
│   │   ├── usePtyChat.ts            # PTY chat
│   │   ├── useUndoRedo.ts           # Undo/redo logic
│   │   ├── useWorktrees.ts          # Worktree management
│   │   └── [20+ other hooks]
│   │
│   └── lib/
│       ├── types.ts         # TS interfaces (Turn, TurnContentBlock, etc.)
│       ├── parser.ts        # JSONL → ParsedSession conversion
│       ├── format.ts        # Token formatting, path utils
│       ├── auth.ts          # Network auth token management
│       ├── utils.ts         # cn(), MODEL_OPTIONS, etc.
│       └── undo-engine.ts   # Undo/redo state machine
│
├── server/
│   ├── api-plugin.ts        # Vite plugin (registers routes)
│   ├── pty-plugin.ts        # Vite plugin (PTY WebSocket)
│   ├── config.ts            # Config file I/O
│   ├── helpers.ts           # Shared utilities, middleware
│   │
│   └── routes/
│       ├── config.ts            # Configuration
│       ├── projects.ts          # Project listing
│       ├── claude.ts            # Session streaming
│       ├── claude-new.ts        # Launch new sessions
│       ├── claude-manage.ts     # Kill sessions
│       ├── ports.ts             # Port checking, background tasks/agents
│       ├── teams.ts             # Team management
│       ├── team-session.ts      # Team session ops
│       ├── undo.ts              # Undo/redo
│       ├── files.ts             # File operations
│       ├── files-watch.ts       # File stream watching
│       ├── session-file-changes.ts  # Edit/Write tracking
│       ├── editor.ts            # Editor operations
│       ├── worktrees.ts         # Git worktree API
│       └── usage.ts             # Token usage tracking
│
├── public/                  # Static assets
├── docs/plans/             # Design documents
├── vite.config.ts          # Vite config
├── electron.vite.config.ts # Electron build config
├── electron-builder.yml    # Packaging config
└── package.json            # Dependencies
```

---

## Key Design Patterns

### 1. Route Registration

**Pattern:** Routes are registered in a "register*Routes" function that accepts Express `use` middleware.

```typescript
// server/routes/ports.ts
export function registerPortRoutes(use: UseFn) {
  use("/api/check-ports", async (req, res) => { ... })
  use("/api/background-tasks", async (req, res) => { ... })
}

// Both places must register:
use = app.use.bind(app)  // in electron/server.ts
registerPortRoutes(use)
```

### 2. SSE Streaming

Sessions are watched for changes via `fs.watch` and streamed to clients:
- `/api/watch/:dir/:file` — New JSONL lines pushed to connected clients
- `requestAnimationFrame` throttling on client (100ms max latency)
- Incremental parsing avoids full re-parses

### 3. Session Parsing

JSONL is parsed into strongly-typed `ParsedSession`:
1. Read file line-by-line
2. Convert to `RawMessage` (union of user, assistant, progress, system messages)
3. Aggregate into `Turn` objects with `contentBlocks` (preserves chronological order)
4. Compute stats (tokens, costs, errors, duration)

### 4. Dual-Server Architecture

Same routes run in two environments:
- **Dev:** Vite plugin (via `server/api-plugin.ts`)
- **Production:** Express server (via `electron/server.ts`)

If a route exists in only one, behavior diverges between `bun run dev` and built app.

---

## Testing

**Test policy** (from CLAUDE.md):
- Test files: `src/**/__tests__/*.test.ts` and `server/__tests__/**/*.test.ts`
- Run: `bun run test`
- All changes must have passing tests before merge
- Tests must be updated if behavior changes

---

## Development Workflow

### Running in Development

```bash
# Browser-based dashboard (Vite dev server)
bun run dev
# Opens http://localhost:5173

# Electron app with hot reload
bun run electron:dev
# Watches for changes, rebuilds on save
```

### Building for Production

```bash
# Type check + build web
bun run build
bun run preview  # Test production build

# Build Electron app (DMG on macOS, AppImage/deb on Linux)
bun run electron:package
# Output: release/
```

---

## Quick Reference: Adding a New Feature

### Adding a New API Route

1. Create route handler in `server/routes/{feature}.ts`:
   ```typescript
   export function registerFeatureRoutes(use: UseFn) {
     use("/api/feature", async (req, res) => { ... })
   }
   ```

2. Register in **both**:
   - `server/api-plugin.ts` — `registerFeatureRoutes(use)`
   - `electron/server.ts` — `registerFeatureRoutes(use)`

3. Call from frontend via `authFetch("/api/feature")`

### Adding a UI Component

1. Create component in `src/components/{name}.tsx`
2. If it needs data fetching:
   - Create hook in `src/hooks/use{Name}.ts`
   - Use `useEffect` + `authFetch` for API calls
   - Return state + callbacks
3. Integrate into layout in `App.tsx` or parent component
4. Test with `bun run test`

### Monitoring Background Agents

Watch for:
- `agent_progress` JSONL entries with `run_in_background: true` parent
- Query `/api/background-agents?cwd={projectPath}` for active agents
- Subscribe to SSE `/api/watch-team/{teamName}` for team-spawned agents
- Display in `StatsPanel` → `BackgroundAgents` component

---

## Environment & Configuration

### Configuration File

Location (Electron): `~/Library/Application Support/Cogpit/config.local.json`
Location (Web): `config.local.json` in project root

```json
{
  "claudeDir": "/Users/you/.claude",
  "networkAccess": true,
  "networkPassword": "secret123",
  "terminalApp": "Ghostty"
}
```

### Environment Variables

- `ELECTRON_RENDERER_URL` — Dev server URL (set by electron-vite during dev)
- `PATH` — Manually resolved from shell in `electron/main.ts` to find `claude` CLI

---

## Security

- **Preload script** — Uses contextIsolation + sandbox
- **Auth middleware** — Checks network access settings
- **Session tokens** — Generated for remote WebSocket clients
- **Password protection** — Remote network access requires authentication
- **Permission modes** — User can configure how dashboard interacts with Claude Code (bypassPermissions, acceptEdits, delegate, etc.)

---

## Next Steps for Implementation

If you're building a feature involving background agents:

1. **Detection** — Monitor `/api/background-agents` API
2. **Display** — Render in StatsPanel or new component
3. **Interaction** — Click to load session, kill process, view logs
4. **Notifications** — Alert user on completion (no system yet; recommend adding toast/alert)
5. **Persistence** — Store agent state in session JSONL (already done via `agent_progress`)

For notifications specifically:
- Decide on UI style (toast, modal, badge)
- Hook into SSE events or polling completion checks
- Implement dismissal logic (auto-hide, click to close)
- Consider user preferences (sound, desktop notifications, etc.)

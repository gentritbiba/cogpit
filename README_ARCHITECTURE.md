# Cogpit Project Architecture Summary

I've created comprehensive documentation of this Electron app's architecture. Here's what you need to know:

## What This App Is

**Cogpit** is a real-time dashboard for Claude Code agent sessions. It:
- Monitors local Claude Code projects and sessions
- Displays live conversation threads with agent activity
- Tracks background sub-agents spawned via Task tool with `run_in_background: true`
- Monitors background servers/dev servers (port detection)
- Provides undo/redo with branching, token analytics, file tracking, and permission management
- Runs as an Electron desktop app or web dashboard

## How It Launches & Executes

### Application Flow

1. **Electron main process** (`electron/main.ts`)
   - Resolves shell PATH to find `claude` CLI
   - Creates BrowserWindow
   - Starts embedded Express server at `http://127.0.0.1:19384`

2. **Express server** (`electron/server.ts`)
   - Registers API routes from `server/routes/*.ts`
   - Serves static React app (or proxies to Vite in dev)
   - Handles WebSocket for PTY (terminal) sessions
   - Implements SSE (Server-Sent Events) for live updates

3. **React frontend** (`src/App.tsx`)
   - Loads session JSONL files from `~/.claude/projects/`
   - Polls for background agents every 5 seconds via `/api/background-agents`
   - Displays live conversation with background agent activity in violet-themed panels
   - Provides UI for managing sessions, branches, and monitoring

## Key Architectural Pattern: Dual Route Registration

**CRITICAL:** Every API route must be registered in **BOTH** places:
- `server/api-plugin.ts` — Vite plugin (dev server)
- `electron/server.ts` — Express server (production)

If a route is only in one place, it won't work in the other environment.

## Background Agent Integration

### How It Works

1. Claude calls Task tool with `run_in_background: true`
2. Task output written to `/private/tmp/claude-{uid}/{hash}/tasks/{taskId}.output`
3. Parent session JSONL includes `agent_progress` entries
4. Parser (`src/lib/parser.ts`) detects background Task calls and tags corresponding messages
5. Frontend polls `/api/background-agents?cwd={path}` every 5 seconds
6. Displays in `StatsPanel` with violet color scheme

### Key APIs

- **`GET /api/background-agents?cwd={path}`** — List running background agents
- **`GET /api/background-tasks?cwd={path}`** — Find dev servers (port detection)
- **`GET /api/check-ports?ports=3000,5173`** — Test if ports are listening
- **`POST /api/kill-port`** — Stop process on port

### Data Model

```typescript
interface SubAgentMessage {
  agentId: string
  isBackground: boolean  // ← TRUE for background agents
  type: "user" | "assistant"
  tokenUsage: TokenUsage | null
  text: string[]
  thinking: string[]
  toolCalls: ToolCall[]
  timestamp: string
}

// Background agent messages render in separate block with violet theme
type TurnContentBlock =
  | { kind: "background_agent"; messages: SubAgentMessage[] }
  | { kind: "sub_agent"; messages: SubAgentMessage[] }  // foreground
  | ...
```

## Notification System

**Status:** Not yet implemented.

Currently the app has no toast/alert system. Errors appear in browser console. You'll need to:

1. **Create Toast component** — Simple dismissible popup in corner
2. **Add ToastContainer** — Manages multiple toasts (top-right corner typical)
3. **Hook into polling** — Detect agent completion, server status changes, API errors
4. **Display notifications** — When agents finish, ports come online, errors occur

See `AGENT_INTEGRATION.md` for detailed implementation guide.

## File Organization

```
cogpit/
├── electron/
│   ├── main.ts           # Electron app entry point
│   ├── server.ts         # Express server + route registration
│   └── preload.ts        # Sandbox preload script
│
├── src/
│   ├── App.tsx           # Root layout component
│   ├── components/
│   │   ├── StatsPanel.tsx              # Shows background agents/servers
│   │   ├── timeline/BackgroundAgentPanel.tsx  # Violet panel for agents
│   │   └── [35+ other components]
│   ├── hooks/            # [25+ custom hooks]
│   └── lib/
│       ├── parser.ts     # JSONL → ParsedSession (detects background agents)
│       ├── types.ts      # TypeScript interfaces
│       └── [utils, format, auth]
│
├── server/
│   ├── routes/           # [12 route modules]
│   │   ├── ports.ts           # background-agents, background-tasks, check-ports
│   │   ├── projects.ts        # project discovery
│   │   ├── claude.ts          # session streaming
│   │   └── [9 more routes]
│   ├── api-plugin.ts    # Vite plugin wrapper
│   ├── pty-plugin.ts    # WebSocket PTY
│   └── helpers.ts       # Shared utilities
│
├── ARCHITECTURE.md              # ← Comprehensive guide (created)
├── AGENT_INTEGRATION.md         # ← Agent execution & notifications (created)
├── QUICK_REFERENCE.md          # ← Quick lookup guide (created)
└── package.json         # Dependencies, scripts
```

## Running the App

### Development

```bash
# Browser dashboard (Vite dev server)
bun run dev
# Opens http://localhost:5173

# Electron with hot reload
bun run electron:dev
# Watches for changes, rebuilds on save
```

### Production

```bash
# Build web
bun run build && bun run preview

# Build Electron (DMG on macOS, AppImage/deb on Linux)
bun run electron:package
# Output: release/
```

## Testing

```bash
bun run test         # Run all tests
bun run test:watch   # Watch mode
bun run lint         # Lint + type check
```

Test policy:
- Every code change must have passing tests
- Test files: `src/**/__tests__/*.test.ts` and `server/__tests__/**/*.test.ts`
- Update affected tests when behavior changes

## Documentation Created

### 1. **ARCHITECTURE.md** (This Directory)
Comprehensive technical documentation covering:
- How the app launches (Electron → Express → React)
- How agents are executed and monitored
- All API routes (12+ endpoints)
- Data models and parsing logic
- UI component hierarchy
- Design patterns (dual registration, SSE streaming, session parsing)
- Testing requirements
- Security considerations

### 2. **AGENT_INTEGRATION.md** (This Directory)
Detailed guide for agent monitoring and notifications:
- How agents are spawned (Task tool with `run_in_background: true`)
- Where to find running agents (`/api/background-agents`)
- Current UI display (StatsPanel, BackgroundAgentPanel)
- Where to add notifications (5 specific locations)
- Complete Toast component implementation guide
- Color scheme for notifications
- Testing approach
- Integration checklist

### 3. **QUICK_REFERENCE.md** (This Directory)
Quick lookup guide with:
- App overview and architecture diagram
- Running commands
- API routes summary table
- Component hierarchy
- Key types and interfaces
- File structure critical paths
- Common tasks (add route, component, monitor agents)
- Keyboard shortcuts
- Debugging tips
- Common issues & fixes

## Key Takeaways

1. **This is a comprehensive Claude Code monitoring dashboard** — Shows live agent sessions with real-time updates
2. **Background agents are actively monitored** — Separate polling endpoint every 5 seconds
3. **Electron app with embedded server** — Dual-registration pattern for API routes (critical!)
4. **Strong TypeScript, no notifications yet** — Good testing infrastructure, notifications are missing
5. **Agent spawning via Task tool** — Detected via `run_in_background: true` flag in parser

## Next Steps

If you're implementing features:

1. **Adding notification system** — See AGENT_INTEGRATION.md for complete implementation
2. **Adding new API route** — Register in both `server/api-plugin.ts` and `electron/server.ts`
3. **Monitoring background agents** — Use `/api/background-agents?cwd={path}` endpoint
4. **Understanding parsing** — Check `src/lib/parser.ts` lines 175-196 for background agent tagging
5. **Testing changes** — Run `bun run test` before committing

All documentation is in this directory:
- `/Users/gentritbiba/.claude/agent-window/ARCHITECTURE.md`
- `/Users/gentritbiba/.claude/agent-window/AGENT_INTEGRATION.md`
- `/Users/gentritbiba/.claude/agent-window/QUICK_REFERENCE.md`

## Questions to Answer

**Q: What does this app do?**
A: Real-time dashboard for Claude Code agent sessions with background agent monitoring, token analytics, undo/redo, and team dashboards.

**Q: How does the app launch/run agents?**
A: Electron main process → Express server on 127.0.0.1:19384 → React frontend. Agents are spawned via Claude's Task tool with `run_in_background: true`, detected via `/api/background-agents` polling every 5 seconds.

**Q: How are CLI commands executed?**
A: The Electron main process resolves the shell PATH to find the `claude` CLI. Routes that need to execute CLI commands (like `/api/open-terminal`) spawn processes using Node's child_process module.

**Q: Is there a notification system?**
A: No. Currently errors appear in browser console. See AGENT_INTEGRATION.md for full implementation guide.

**Q: Where is the Electron main process?**
A: `/Users/gentritbiba/.claude/agent-window/electron/main.ts`

**Q: Where are the API routes?**
A: `/Users/gentritbiba/.claude/agent-window/server/routes/` (12 modules) — must register in BOTH `server/api-plugin.ts` (Vite) and `electron/server.ts` (Express).

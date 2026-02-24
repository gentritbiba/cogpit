# Cogpit Quick Reference

## What This App Does

**Cogpit** = Real-time dashboard for Claude Code agent sessions

- Browse all Claude Code projects & sessions
- Watch live agent activity as it streams
- Monitor background sub-agents (Task tool with `run_in_background: true`)
- Track dev servers & background processes (port detection)
- Undo/redo sessions with branching
- Inspect token usage, file changes, permissions
- Team dashboards for multi-agent workflows

---

## Key Architecture

```
Electron App
    ↓
Express Server (port 19384)
    ├── Vite proxy (dev) / Static files (prod)
    ├── API routes (12 files in server/routes/)
    ├── PTY WebSocket (terminal)
    └── SSE streaming (live updates)
    ↓
React 19 Frontend
    ├── Main layout (sidebar + chat + stats)
    ├── Live session parsing (JSONL → ParsedSession)
    ├── Background agent monitoring
    └── UI state (hooks + reducer)
```

---

## Running the App

### Development
```bash
# Browser dashboard
bun run dev
# http://localhost:5173

# Electron app (with hot reload)
bun run electron:dev
```

### Production Build
```bash
# Web
bun run build && bun run preview

# Electron
bun run electron:package
# Output: release/ (DMG on macOS, AppImage/deb on Linux)
```

---

## How Background Agents Work

1. **Claude calls Task tool** with `run_in_background: true`
2. **Task output written** to `/private/tmp/claude-{uid}/{hash}/tasks/{id}.output`
3. **For agents:** Symlink points to agent's JSONL file
4. **Parent session** includes `agent_progress` JSONL entries
5. **Parser tags** messages with `isBackground: true`
6. **Frontend polls** `/api/background-agents` every 5 seconds
7. **Displays in StatsPanel** → click to load agent session

---

## API Routes Summary

| Route | What It Does |
|-------|--------------|
| `/api/projects` | List projects |
| `/api/projects/:dir` | List sessions in project |
| `/api/sessions/:dir/:file` | Load full session JSONL |
| `/api/watch/:dir/:file` | SSE stream for live session |
| `/api/background-agents?cwd=` | Find running background agents |
| `/api/background-tasks?cwd=` | Find dev servers (port detection) |
| `/api/check-ports?ports=` | Test if ports are listening |
| `/api/kill-port` | Stop process on port |
| `/api/teams` | List teams |
| `/api/undo` / `/api/redo` | Undo/redo with branching |
| `/api/pty` | WebSocket terminal |
| `/__pty` | PTY WebSocket connection |

---

## Component Hierarchy

```
App.tsx
├── DesktopHeader
├── ResizablePanelGroup
│   ├── SessionBrowser (sidebar)
│   ├── ChatArea (main)
│   │   ├── ConversationTimeline
│   │   │   └── Turn renderer
│   │   │       ├── SubAgentPanel (blue)
│   │   │       └── BackgroundAgentPanel (violet)
│   │   └── ChatInput
│   └── StatsPanel
│       ├── TokenChart
│       ├── BackgroundServers (blue)
│       └── BackgroundAgents (violet)
└── ToastContainer (notifications) ← ADD HERE
```

---

## Key Types

### ParsedSession
```typescript
{
  sessionId: string
  turns: Turn[]
  stats: SessionStats
  cwd: string
  model: string
}
```

### Turn
```typescript
{
  id: string
  userMessage: UserContent | null
  contentBlocks: TurnContentBlock[]  // ← ordered blocks
  assistantText: string[]
  toolCalls: ToolCall[]
  subAgentActivity: SubAgentMessage[]
  tokenUsage: TokenUsage | null
}
```

### TurnContentBlock (union)
```typescript
| { kind: "thinking"; blocks: ThinkingBlock[] }
| { kind: "text"; text: string[] }
| { kind: "tool_calls"; toolCalls: ToolCall[] }
| { kind: "sub_agent"; messages: SubAgentMessage[] }      // ← Blue
| { kind: "background_agent"; messages: SubAgentMessage[] }  // ← Violet
```

### SubAgentMessage
```typescript
{
  agentId: string
  type: "user" | "assistant"
  content: unknown
  toolCalls: ToolCall[]
  timestamp: string
  tokenUsage: TokenUsage | null
  isBackground: boolean  // ← TRUE for background agents
}
```

---

## File Structure (Critical Paths)

```
electron/
  main.ts          ← App entry, window creation
  server.ts        ← Express server, route registration

src/
  App.tsx          ← Root layout, main state management
  components/
    StatsPanel.tsx       ← Background agents & servers display
    ConversationTimeline.tsx  ← Turn/content block rendering
    timeline/BackgroundAgentPanel.tsx  ← Violet panel for background agents
  hooks/
    useLiveSession.ts    ← SSE streaming
    useSessionState.ts   ← Global state reducer
  lib/
    types.ts        ← TS interfaces
    parser.ts       ← JSONL → ParsedSession
    format.ts       ← Utilities

server/
  routes/
    ports.ts        ← background-agents, background-tasks, check-ports
    projects.ts     ← Project/session discovery
    claude.ts       ← Session streaming
  api-plugin.ts    ← Vite plugin registration
  pty-plugin.ts    ← WebSocket PTY
```

---

## Dual Registration Pattern

**Every new route must be registered in BOTH places:**

1. **`server/api-plugin.ts`** — Vite plugin (dev mode)
   ```typescript
   registerFeatureRoutes(use)
   ```

2. **`electron/server.ts`** — Express server (both dev and prod)
   ```typescript
   registerFeatureRoutes(use)
   ```

If you only register in one, the route won't work in the other environment.

---

## Common Tasks

### Adding a New API Route

1. Create `server/routes/feature.ts`:
   ```typescript
   export function registerFeatureRoutes(use: UseFn) {
     use("/api/feature", async (req, res) => { ... })
   }
   ```

2. Register in `server/api-plugin.ts` (Vite)
3. Register in `electron/server.ts` (Express)
4. Call from frontend: `authFetch("/api/feature")`

### Adding a UI Component

1. Create `src/components/Feature.tsx`
2. Use hooks for state/fetching
3. Integrate into App layout
4. Add tests in `src/components/__tests__/Feature.test.ts`

### Monitoring Background Agents

- Poll `/api/background-agents?cwd={path}` every 5 seconds
- Watch for `isActive` changes
- Display agent status in StatsPanel
- Click to load agent session: `onLoadSession?.(dirName, fileName)`

### Adding Notifications

1. Create Toast component in `src/components/Toast.tsx`
2. Create ToastContainer in same file
3. Create useToast hook
4. Mount `<ToastContainer />` in App.tsx
5. Call `useToast()` from components that need notifications
6. Test with `bun run test`

---

## Testing

```bash
bun run test         # Run all tests
bun run test:watch   # Watch mode
bun run test:coverage # Coverage report
bun run lint         # ESLint + type check
bun run typecheck    # TypeScript check
```

Test files: `src/**/__tests__/*.test.ts` and `server/__tests__/**/*.test.ts`

---

## Keyboard Shortcuts (Existing)

| Key | Action |
|-----|--------|
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+E` | Expand all turns |
| `Ctrl+Shift+E` | Collapse all turns |
| `Ctrl+Shift+M` | Voice input (Whisper WASM) |
| `Ctrl+Cmd+T` (macOS) | Open terminal |
| `Ctrl+Alt+T` (Linux) | Open terminal |
| `Ctrl+Shift+1-9` | Jump to live session N |
| `Esc` | Clear search |

---

## Styling & Theme

- **Framework:** Tailwind CSS 4 + custom properties
- **Components:** Radix UI (headless primitives)
- **Colors:** Dark theme with semantic color palette
- **Background agents:** Violet color scheme (distinguish from blue foreground agents)

Custom color example:
```tsx
className="border border-violet-500/30 text-violet-400"
```

---

## Environment

- **OS:** macOS, Linux (Windows via WSL in theory)
- **Runtime:** Node.js 18+ (or Bun)
- **Package Manager:** Bun (not npm)
- **Desktop:** Electron 40 + electron-vite
- **Browser:** Chromium (via Electron)

---

## Debugging

### Browser Console
```javascript
// Check live session state
window.__app?.state

// Check error logs
console.error  // Check DevTools console (F12)
```

### Electron Dev Tools
```bash
Ctrl+Shift+I  # Open DevTools in Electron app
```

### Network
```bash
# Check API calls in DevTools → Network tab
# Check WebSocket in Console → type: "pty" messages
```

### Session Parsing
```bash
# Add debug logging in src/lib/parser.ts
console.log("[parser]", "parsing turn", turnIndex)
```

---

## Common Issues & Fixes

### "Failed to fetch agents"
- Check network access settings (toggle in ConfigDialog)
- Verify `/api/background-agents` route is registered in both api-plugin and server.ts
- Check browser console for CORS errors

### Background agents not showing
- Verify symlinks exist in `/private/tmp/claude-{uid}/{hash}/tasks/`
- Check `isBackground` flag is being set in parser (src/lib/parser.ts line 189)
- Verify background agent polling is running (check network tab for `/api/background-agents` requests)

### Ports not detected
- Check port regex in `StatsPanel.tsx` line 370: `PORT_RE = /(?::(\d{4,5}))|...`
- Verify task output file contains port number
- Check `/api/check-ports` response for port status

### No notifications appearing
- Verify `<ToastContainer />` is mounted in App.tsx
- Check toast is being called: `toast("message", "success")`
- Verify `__cogpit_toast` global function exists

---

## Next Features to Build

1. **Task notifications** — Alert when background agents complete
2. **Error detection** — Surface errors from agent output
3. **Keyboard shortcuts** — Quick actions for killing tasks
4. **Desktop notifications** — OS-level alerts (requires Electron API)
5. **Agent status panel** — Dedicated sidebar section for running agents
6. **Agent output streaming** — View live output from background agent (like ServerPanel)

---

## Useful Links

- [Electron docs](https://www.electronjs.org/docs)
- [electron-vite](https://electron-vite.org/)
- [React docs](https://react.dev/)
- [Tailwind CSS docs](https://tailwindcss.com/)
- [Radix UI docs](https://www.radix-ui.com/)
- [TypeScript docs](https://www.typescriptlang.org/docs/)

---

## Performance Notes

- **Virtualization:** 30+ turns are virtualized (use @tanstack/react-virtual)
- **SSE throttling:** Updates coalesced with requestAnimationFrame (100ms max latency)
- **Polling:** Background agents polled every 5 seconds; ports polled every 10 seconds
- **JSONL parsing:** Incremental (only new lines re-parsed) via `parseSessionAppend`

---

## Security & Permissions

- **Sandbox:** Renderer runs in sandbox with contextIsolation
- **Preload:** Limited API surface in preload.ts
- **Auth:** Network access protected with password + session tokens
- **Permissions:** User configurable for Claude Code interaction (bypassPermissions, acceptEdits, delegate, etc.)

---

## Support

For questions or issues:
1. Check ARCHITECTURE.md for detailed design
2. Check AGENT_INTEGRATION.md for agent-specific patterns
3. Search codebase: `grep -r "term"` in project root
4. Check tests in `src/__tests__/` for usage examples
5. Review comments in relevant route files (`server/routes/`)

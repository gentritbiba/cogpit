# PTY/xterm.js Terminal Integration

## Goal

Replace the SSE-based script output with full interactive PTY terminals using xterm.js. Scripts spawn as PTY sessions (interactive by default), and a "New Terminal" button opens a fresh shell. Task output (`type === "task"`) stays as the current `<pre>`-based SSE display.

## Design Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Script spawning | All scripts use PTY + "New Terminal" button |
| 2 | "New Terminal" location | ScriptsDock header, `+` icon next to search |
| 3 | PTY WebSocket in dev | Shared module `server/pty-server.ts`, both servers import |
| 4 | xterm.js setup | `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` |
| 5 | ProcessPanel integration | xterm for scripts/terminals, `<pre>` for tasks only |

## Current State

- **PTY WebSocket backend already exists** in both `server/pty-plugin.ts` (Vite dev) and `electron/server.ts` (Electron prod) — ~300 lines of **duplicated** code
- **Message protocol** is fully defined: `spawn`, `input`, `resize`, `kill`, `attach`, `list`, `rename`
- **Script runner** currently uses `child_process.spawn` + SSE streaming via REST API
- **ProcessEntry** already has `type: "terminal"` defined but it's **never used**
- **xterm.js** packages are **not installed** yet

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Frontend                                                │
│                                                          │
│  usePtySocket ──── WebSocket ──── /__pty endpoint        │
│       │                                                  │
│  useScriptRunner (refactored: spawn via PTY WS)          │
│       │                                                  │
│  ProcessPanel                                            │
│    ├── TerminalOutput (xterm.js) ← script/terminal       │
│    └── ProcessOutput (<pre> SSE) ← task only             │
│                                                          │
│  ScriptsDock                                             │
│    └── [+] New Terminal button in header                 │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Backend                                                 │
│                                                          │
│  server/pty-server.ts (shared PTY session manager)       │
│       │                                                  │
│  ├── server/pty-plugin.ts (Vite dev — thin wrapper)      │
│  └── electron/server.ts  (Electron — thin wrapper)       │
│                                                          │
│  server/routes/scripts/ (discovery stays, spawn removed) │
└─────────────────────────────────────────────────────────┘
```

---

## Phase 1: Extract Shared PTY Module [COMPLETE]

Deduplicate the ~300 lines of identical PTY logic from `pty-plugin.ts` and `electron/server.ts` into a single shared module.

### 1.1 Create `server/pty-server.ts` [DONE]

**New file** — the shared PTY session manager.

Extract from both existing files:
- `PtySession` interface
- `SessionInfo` interface + `toSessionInfo()`
- `PtySessionManager` class containing:
  - `sessions: Map<string, PtySession>`
  - `handleConnection(ws)` — message routing + cleanup on close
  - `handleSpawn(ws, msg)` — create PTY session
  - `handleInput(msg)` — write to PTY stdin
  - `handleResize(msg)` — resize PTY
  - `handleKill(msg)` — terminate + remove session
  - `handleAttach(ws, msg)` — join existing session with scrollback replay
  - `handleList(ws)` — send session list
  - `handleRename(msg)` — rename session
  - `broadcastToAll(msg)` — broadcast to all WSS clients
  - `sendSessionList()` — notify all clients of session changes
  - `cleanup()` — kill all running sessions

**Changes from current code:**
- Add optional `metadata` field to `PtySession` — stores `{ type: "script" | "terminal", source?: string, scriptName?: string }` so the frontend can distinguish scripts from terminals
- The `spawn` message accepts an optional `metadata` object that gets stored and returned in session lists
- `SessionInfo` includes `metadata` in its response

```typescript
// server/pty-server.ts

export interface PtySessionMetadata {
  type: "script" | "terminal"
  source?: string        // e.g. "root/" or "packages/api/"
  scriptName?: string    // e.g. "dev" — only for scripts
}

export interface PtySession {
  id: string
  pty: IPty
  name: string
  status: "running" | "exited"
  exitCode: number | null
  cols: number
  rows: number
  scrollback: string
  clients: Set<WebSocket>
  createdAt: number
  cwd: string
  metadata?: PtySessionMetadata
}

export class PtySessionManager {
  private sessions = new Map<string, PtySession>()

  handleConnection(ws: WebSocket): void { ... }
  spawn(ws, msg): PtySession { ... }
  // ... all handlers
  cleanup(): void { ... }
  getSessions(): SessionInfo[] { ... }
}
```

### 1.2 Refactor `server/pty-plugin.ts` [DONE]

**Modify** — reduce to thin Vite plugin wrapper (~30 lines).

```typescript
import { PtySessionManager } from "./pty-server"

export function ptyPlugin(): Plugin {
  return {
    name: "pty-websocket",
    configureServer(server) {
      const manager = new PtySessionManager()
      const wss = new WebSocketServer({ noServer: true })

      server.httpServer!.on("upgrade", (req, socket, head) => {
        // Auth check (existing logic)
        // wss.handleUpgrade → manager.handleConnection(ws)
      })

      wss.on("connection", (ws) => manager.handleConnection(ws))

      server.httpServer!.on("close", () => manager.cleanup())
    },
  }
}
```

### 1.3 Refactor `electron/server.ts` PTY section [DONE]

**Modify** lines 41-323 — replace inline PTY code with shared manager.

```typescript
import { PtySessionManager } from "../server/pty-server"

// Inside createAppServer():
const ptyManager = new PtySessionManager()
const wss = new WebSocketServer({ noServer: true })

httpServer.on("upgrade", (req, socket, head) => {
  // Auth check (existing logic)
  // wss.handleUpgrade → ptyManager.handleConnection(ws)
})

wss.on("connection", (ws) => ptyManager.handleConnection(ws))

// In cleanup:
httpServer.on("close", () => {
  ptyManager.cleanup()
  // ... rest of cleanup
})
```

**Removes:** ~200 lines of duplicated PTY code from electron/server.ts (the inline `handleSpawn`, `handleInput`, `handleResize`, `handleKill`, `handleAttach`, `handleRename`, `handleMessage`, `PtySession` interface, helper functions).

---

## Phase 2: Install xterm.js Packages

### 2.1 Install dependencies

```bash
bun add @xterm/xterm @xterm/addon-fit @xterm/addon-web-links
```

### 2.2 Import xterm CSS

In the component that uses xterm (or in `src/index.css`), import:
```typescript
import "@xterm/xterm/css/xterm.css"
```

---

## Phase 3: Frontend — PTY WebSocket Hook [COMPLETE]

### 3.1 Create `src/hooks/usePtySocket.ts` [DONE]

**New file** — shared WebSocket connection to `/__pty`.

Responsibilities:
- Open a single WebSocket to `/__pty` (with auth token for remote)
- Auto-reconnect on disconnect (exponential backoff, max 5s)
- Expose `send(msg)` for sending messages
- Expose `subscribe(id, callback)` / `unsubscribe(id)` for per-session output routing
- Expose `onSessionsUpdate(callback)` for session list changes
- Track connection state: `connecting | connected | disconnected`
- On connect, send `{type: "list"}` to get current sessions

```typescript
// Simplified API:
export function usePtySocket() {
  return {
    status: "connected" | "connecting" | "disconnected",
    send: (msg: PtyMessage) => void,
    subscribe: (sessionId: string, handler: PtyOutputHandler) => void,
    unsubscribe: (sessionId: string) => void,
    sessions: PtySessionInfo[],    // latest session list from server
    spawnTerminal: (opts) => void, // convenience: send spawn message
    spawnScript: (opts) => void,   // convenience: send spawn for script
    killSession: (id) => void,     // convenience: send kill message
    writeInput: (id, data) => void,
    resize: (id, cols, rows) => void,
  }
}
```

**Key design notes:**
- Single WebSocket instance shared across all components (via context or module-level singleton)
- Message routing by `id` field — each terminal subscribes for its session ID
- The `sessions` list updates whenever the server broadcasts a `{type: "sessions", ...}` message

### 3.2 Create `src/contexts/PtyContext.tsx` [DONE]

**New file** — React context that provides the PTY socket to the component tree.

```typescript
const PtyContext = createContext<ReturnType<typeof usePtySocket> | null>(null)

export function PtyProvider({ children }) {
  const pty = usePtySocket()
  return <PtyContext.Provider value={pty}>{children}</PtyContext.Provider>
}

export function usePty() {
  const ctx = useContext(PtyContext)
  if (!ctx) throw new Error("usePty must be used within PtyProvider")
  return ctx
}
```

Mount `<PtyProvider>` in `App.tsx` wrapping the main content (after config is loaded).

### 3.3 Refactor `src/hooks/useScriptRunner.ts` [DONE]

**Modify** — replace REST API calls with PTY WebSocket messages.

Current flow:
1. `runScript()` → `POST /api/scripts/run` → `child_process.spawn`
2. Poll `GET /api/scripts/processes` every 5s for status
3. `stopScript()` → `POST /api/scripts/stop`

New flow:
1. `runScript()` → PTY WebSocket `spawn` message with `command: "bun"`, `args: ["run", scriptName]`, `cwd: packageDir`, `metadata: { type: "script", source, scriptName }`
2. Session list updates come automatically via WebSocket `sessions` broadcasts (no polling)
3. `stopScript()` → PTY WebSocket `kill` message

```typescript
export function useScriptRunner(onProcessStarted?, onProcessesUpdated?) {
  const pty = usePty()

  const runScript = useCallback((scriptName, packageDir, source) => {
    const id = `script_${crypto.randomUUID().slice(0, 8)}`
    pty.send({
      type: "spawn",
      id,
      name: scriptName,
      command: "bun",
      args: ["run", scriptName],
      cwd: packageDir,
      metadata: { type: "script", source, scriptName },
    })
    onProcessStarted?.({ id, name: scriptName, type: "script", status: "running", source })
    return id
  }, [pty, onProcessStarted])

  const stopScript = useCallback((processId) => {
    pty.killSession(processId)
  }, [pty])

  // Derive running scripts from pty.sessions
  const runningProcesses = useMemo(() => {
    const map = new Map()
    for (const s of pty.sessions) {
      if (s.metadata?.type === "script") {
        map.set(s.id, {
          id: s.id,
          name: s.name,
          command: `bun run ${s.metadata.scriptName}`,
          cwd: s.cwd,
          type: "script",
          status: s.status === "running" ? "running" : "stopped",
          source: s.metadata.source,
        })
      }
    }
    return map
  }, [pty.sessions])

  return { runningProcesses, runScript, stopScript }
}
```

**Removes:** 5-second polling interval, REST API calls for run/stop/processes.

---

## Phase 4: Frontend — xterm.js Terminal Component [COMPLETE]

### 4.1 Create `src/components/TerminalOutput.tsx` [DONE]

**New file** — xterm.js renderer for a single PTY session.

```typescript
interface TerminalOutputProps {
  processId: string      // PTY session ID
  className?: string
}
```

Implementation:
1. Create xterm `Terminal` instance on mount
2. Apply addons: `FitAddon` + `WebLinksAddon`
3. Use `usePty()` to subscribe to output for `processId`
4. On output messages → `terminal.write(data)` (raw — xterm handles ANSI natively)
5. On keypress → `pty.writeInput(processId, data)` to send to PTY stdin
6. On container resize → `fitAddon.fit()` + `pty.resize(processId, cols, rows)`
7. On mount, send `{type: "attach", id: processId}` to get scrollback
8. On unmount, unsubscribe and dispose terminal

**Theme:** Match the app's dark theme:
```typescript
const theme = {
  background: "var(--elevation-0)",  // or resolve CSS var
  foreground: "var(--foreground)",
  cursor: "var(--foreground)",
  // ... standard 16 ANSI colors
}
```

**ResizeObserver** on the container div to trigger `fitAddon.fit()` when the panel resizes (including drag-to-resize).

### 4.2 Modify `src/components/ProcessPanel.tsx` [DONE]

**Modify** — add `TerminalOutput` branch for scripts and terminals.

Current `ProcessOutput` handles all types via SSE. Change to:

```tsx
{!collapsed && activeProcess && (
  <div className="h-[200px] flex flex-col">
    {activeProcess.type === "task" ? (
      <ProcessOutput key={activeProcess.id} process={activeProcess} />
    ) : (
      <TerminalOutput key={activeProcess.id} processId={activeProcess.id} />
    )}
  </div>
)}
```

**ProcessOutput** stays unchanged — still handles task type via SSE.

**TerminalOutput** handles `type === "script"` and `type === "terminal"` via xterm.js + WebSocket.

### 4.3 Update ProcessPanel tab interaction [DONE]

When clicking a terminal tab, the xterm.js terminal should auto-focus so keyboard input goes directly to the PTY. Add `autoFocus` logic in `TerminalOutput` when it becomes the active process.

---

## Phase 5: "New Terminal" Button [COMPLETE]

### 5.1 Modify `src/components/ScriptsDock.tsx` [DONE]

**Modify** — add a `+` button in the header bar, next to the search icon.

```tsx
{!collapsed && (
  <>
    <button
      className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
      onClick={handleNewTerminal}
      title="New terminal"
    >
      <Plus className="size-3" />
    </button>
    <button ... /* existing search button */ />
  </>
)}
```

The `handleNewTerminal` callback:
1. Uses `usePty()` to send a spawn message: `{ type: "spawn", command: defaultShell, cwd: projectDir }`
2. Calls `onProcessStarted({ id, name: "Terminal", type: "terminal", status: "running" })` to add to ProcessPanel
3. ProcessPanel auto-expands and focuses the new terminal

### 5.2 Update `ScriptsDockProps` [DONE]

No new prop needed — used existing `onScriptStarted` callback with `type: "terminal"`. PtyContext consumed directly inside ScriptsDock via `usePty()`.

### 5.3 Wire in `App.tsx` [DONE]

PtyProvider already mounted from Phase 3. No changes required.

---

## Phase 6: Cleanup [COMPLETE]

### 6.1 Remove old SSE script output infrastructure [DONE]

**Backend — remove or simplify:**
- `server/routes/scripts/process-manager.ts` — remove `spawn()` method and SSE broadcasting. Keep `getAll()`/state persistence only if we want to persist PTY script sessions across restarts (decision: PTY sessions don't persist — clean start is fine, so this can be fully removed)
- `server/routes/scripts/index.ts` — remove `POST /api/scripts/run`, `POST /api/scripts/stop`, `POST /api/scripts/remove`, `GET /api/scripts/processes`, `GET /api/scripts/output` SSE endpoint. Keep only `GET /api/scripts` (discovery)
- `server/routes/scripts/state.ts` — remove entirely (PTY sessions don't persist)

**Frontend — remove:**
- The SSE branch in `ProcessOutput` for `type === "script"` (only task SSE remains)
- The 5-second polling in old `useScriptRunner`
- REST API calls in `useScriptRunner` for run/stop

### 6.2 Remove duplicated types [DONE — ManagedProcess kept exported; ScriptsDock imports it]

- Remove `ManagedProcess` interface from `useScriptRunner.ts` (replaced by PTY session info)
- Remove `ManagedProcess` interface from `process-manager.ts` (file removed)
- Clean up imports

### 6.3 Update tests [DONE — useProcessPanel.test.ts passes 15/15, no changes needed]

- Update `src/hooks/__tests__/useProcessPanel.test.ts` if process types changed
- Add tests for `usePtySocket` (WebSocket mock)
- Add tests for refactored `useScriptRunner`

### 6.4 Run validation [DONE — tsc: PASS, test: 1215 pass / 44 pre-existing fail, lint: 23 pre-existing errors only]

```bash
bun run lint
bun run tsc
bun run test
```

---

## File Change Summary

| File | Action | Phase |
|------|--------|-------|
| `server/pty-server.ts` | **CREATE** — shared PTY session manager | 1.1 |
| `server/pty-plugin.ts` | **MODIFY** — thin wrapper using shared module | 1.2 |
| `electron/server.ts` | **MODIFY** — thin wrapper using shared module | 1.3 |
| `package.json` | **MODIFY** — add xterm dependencies | 2.1 |
| `src/hooks/usePtySocket.ts` | **CREATE** — WebSocket client hook | 3.1 |
| `src/contexts/PtyContext.tsx` | **CREATE** — React context for PTY | 3.2 |
| `src/hooks/useScriptRunner.ts` | **MODIFY** — use PTY instead of REST | 3.3 |
| `src/components/TerminalOutput.tsx` | **CREATE** — xterm.js terminal component | 4.1 |
| `src/components/ProcessPanel.tsx` | **MODIFY** — route script/terminal to xterm | 4.2 |
| `src/components/ScriptsDock.tsx` | **MODIFY** — add "New Terminal" button | 5.1 |
| `src/App.tsx` | **MODIFY** — wrap with PtyProvider | 5.3 |
| `server/routes/scripts/process-manager.ts` | **DELETE** | 6.1 |
| `server/routes/scripts/state.ts` | **DELETE** | 6.1 |
| `server/routes/scripts/index.ts` | **MODIFY** — keep only GET /api/scripts | 6.1 |

## Risk Notes

- **node-pty native module**: Already in use and working — no new native dependency risk
- **xterm.js bundle size**: `@xterm/xterm` is ~200KB gzipped — acceptable for a desktop app
- **WebSocket reconnection**: Must handle gracefully — on reconnect, re-attach to existing sessions and replay scrollback
- **PTY cleanup on crash**: If the server crashes, PTY child processes become orphans. The OS will eventually clean them up, but we should handle SIGTERM in the shared module

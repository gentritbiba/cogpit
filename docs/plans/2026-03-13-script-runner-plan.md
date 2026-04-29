# Script Runner & Unified Process Panel — Implementation Plan

Design: `docs/plans/2026-03-13-script-runner-design.md`

---

## Phase 1: Backend — Script Discovery & Process Manager

### 1.1 Create `server/routes/scripts/process-manager.ts`

The in-memory process registry. Manages spawning, tracking, and streaming output for user-launched scripts.

**Create file with:**
- `ManagedProcess` interface (id, name, command, cwd, type, status, pid, startedAt, stoppedAt, source)
- `ProcessManager` class:
  - `processes: Map<string, ManagedProcess>` — registry
  - `outputBuffers: Map<string, string>` — ring buffer per process (100KB max)
  - `sseClients: Map<string, Set<ServerResponse>>` — SSE subscribers per process
  - `spawn(opts: { name, command, cwd, source })` — spawns via `child_process.spawn`, wires stdout/stderr to buffer + SSE broadcast, handles exit/error
  - `stop(processId: string)` — sends SIGTERM, updates status
  - `getAll()` — returns all process entries
  - `getOutput(processId: string)` — returns buffered output
  - `subscribe(processId: string, res: ServerResponse)` — adds SSE client
  - `unsubscribe(processId: string, res: ServerResponse)` — removes SSE client
  - `broadcast(processId: string, text: string)` — sends to all SSE clients
- Export a singleton `processManager` instance
- On process exit: update status to `stopped` or `errored`, broadcast status change, persist state
- Ring buffer: append to buffer, trim to last 100KB when exceeded

**Key details:**
- Use `spawn('bun', ['run', scriptName], { cwd, env: process.env, shell: true })` for script execution
  - Fall back to `npm` if bun is not available (check `which bun` on init)
- Capture both stdout and stderr into the same buffer
- Use `randomUUID()` for process IDs prefixed with `proc_`

**Files:** `server/routes/scripts/process-manager.ts` (new)

### 1.2 Create `server/routes/scripts/discovery.ts`

Script discovery — scans project directories for `package.json` files.

**Create file with:**
- `ScriptEntry` interface (name, command, dir, dirLabel, isCommon)
- `COMMON_SCRIPTS` constant: `['dev', 'start', 'build', 'test', 'serve', 'watch', 'preview', 'lint', 'typecheck']`
- `discoverScripts(projectDir: string): Promise<ScriptEntry[]>`:
  1. Read `package.json` in `projectDir`, extract `scripts` object
  2. Read immediate child dirs, check each for `package.json`, extract `scripts`
  3. For each script, create `ScriptEntry` with `isCommon` based on name match
  4. Return sorted: root scripts first, then child dirs alphabetically; within each dir, common first

**Key details:**
- Use `readdir` with `withFileTypes` to scan child dirs
- Skip `node_modules`, `.git`, hidden dirs (starting with `.`)
- `dirLabel` is relative path from projectDir: `"root/"` for the project root, `"packages/api/"` etc for children
- Gracefully handle missing/malformed `package.json` (skip, don't throw)

**Files:** `server/routes/scripts/discovery.ts` (new)

### 1.3 Create `server/routes/scripts/state.ts`

Persistence layer — saves/loads process state for restart awareness.

**Create file with:**
- `ProcessState` interface: `{ processes: ManagedProcess[], lastUpdated: string }`
- `STATE_PATH` — `join(homedir(), '.claude', 'agent-window', 'process-state.json')`
- `saveState(processes: ManagedProcess[])` — write JSON to STATE_PATH
- `loadState(): ProcessState | null` — read and parse, return null if missing/corrupt
  - On load: set all entries to `status: 'stopped'`, clear `pid`

**Files:** `server/routes/scripts/state.ts` (new)

### 1.4 Create `server/routes/scripts/index.ts`

Route registration — HTTP endpoints for script discovery, process management, and output streaming.

**Create file with:**
- `registerScriptRoutes(use: UseFn)` function, registers:

**`GET /api/scripts?dir={projectDir}`**
- Calls `discoverScripts(projectDir)`
- Returns JSON array of `ScriptEntry`

**`POST /api/scripts/run`**
- Body: `{ dir: string, scriptName: string, packageDir: string }`
- Calls `processManager.spawn(...)` with `bun run <scriptName>` in `packageDir`
- Returns `{ id, name, status }`

**`POST /api/scripts/stop`**
- Body: `{ processId: string }`
- Calls `processManager.stop(processId)`
- Returns `{ success: true }`

**`GET /api/scripts/processes`**
- Returns `processManager.getAll()`

**`GET /api/scripts/output?id={processId}`**
- SSE endpoint: sends current buffer as initial event, then subscribes for live updates
- On client disconnect: unsubscribe
- Event format: `{ type: "output", text: "..." }` (matches existing ServerOutput format)
- Also sends `{ type: "status", status: "running"|"stopped"|"errored" }` on status changes

**Files:** `server/routes/scripts/index.ts` (new)

### 1.5 Register script routes in both servers

**`server/api-plugin.ts`:**
- Add import: `import { registerScriptRoutes } from "./routes/scripts"`
- Add call: `registerScriptRoutes(use)` after existing route registrations

**`electron/server.ts`:**
- Add import: `import { registerScriptRoutes } from "../server/routes/scripts"`
- Add call: `registerScriptRoutes(use)` after existing route registrations

**Files:** `server/api-plugin.ts` (edit), `electron/server.ts` (edit)

---

## Phase 2: Frontend — Unified Process Panel (replaces ServerPanel)

### 2.1 Create `src/hooks/useProcessPanel.ts`

New hook replacing `useServerPanel` — manages unified process state for both Claude-spawned tasks and user scripts.

**Create file with:**
- `ProcessEntry` interface: `{ id, name, type: 'script' | 'task' | 'terminal', status: 'running' | 'stopped' | 'errored', source?: string }`
- State:
  - `processes: Map<string, ProcessEntry>` — all known processes
  - `activeProcessId: string | null` — currently selected tab
  - `collapsed: boolean`
- Callbacks:
  - `addProcess(entry: ProcessEntry)` — add to map, set as active, uncollapse
  - `removeProcess(id: string)` — remove from map, switch active to next
  - `setActiveProcess(id: string)` — switch active tab
  - `toggleCollapse()`
  - `handleServersChanged(servers)` — bridge for existing BackgroundServers, adds/updates type='task' entries
  - `handleToggleServer(id, outputPath, title)` — bridge for existing BackgroundServers clicks
- Session switching: save/restore state per session (same pattern as useServerPanel)

**Files:** `src/hooks/useProcessPanel.ts` (new)

### 2.2 Create `src/components/ProcessPanel.tsx`

Unified bottom panel replacing `ServerPanel`. Shows tabbed output for all process types.

**Create file with:**

**`ProcessTab` sub-component:**
- Props: `{ process: ProcessEntry, isActive, onClick, onClose }`
- Renders: badge with process name + type label + status dot + close button
- Type badge: small colored label — `script` (blue), `task` (green), `terminal` (purple)
- Status dot: green=running, red=errored, none=stopped
- Close button: calls `onClose`

**`ProcessOutput` sub-component:**
- Props: `{ processId: string, type: 'script' | 'task' | 'terminal', outputPath?: string }`
- For type=`task`: reuse existing SSE pattern (`/api/task-output?path=...`)
- For type=`script`: connect to `/api/scripts/output?id=...` SSE
- Strips ANSI codes (reuse `stripAnsi` from ServerPanel)
- Auto-scroll with ref, same pattern as current ServerOutput
- Clear button to reset output
- Ring buffer display (100KB)

**`ProcessPanel` main component:**
- Props: `{ processes, activeProcessId, collapsed, onSetActive, onRemove, onToggleCollapse }`
- Header: "Processes" label + collapse toggle
- Tab bar: horizontal scrollable list of ProcessTab for each process
- Body (when expanded): ProcessOutput for the active process
- Auto-opens when a process is added
- `h-[200px]` when expanded, same as current ServerPanel

**Files:** `src/components/ProcessPanel.tsx` (new)

### 2.3 Wire ProcessPanel into App.tsx

Replace ServerPanel with ProcessPanel in the layout.

**Changes to `src/App.tsx`:**
- Replace `import { ServerPanel }` with `import { ProcessPanel }`
- Replace `import { useServerPanel }` with `import { useProcessPanel }`
- Replace `const serverPanel = useServerPanel(...)` with `const processPanel = useProcessPanel(...)`
- Update `serverPanelNode` → `processPanelNode` variable using new component
- Pass `processPanel.handleServersChanged` and `processPanel.handleToggleServer` to BackgroundServers and StatsPanel (same bridge pattern)
- Render `processPanelNode` in same locations (mobile line ~935, desktop line ~1171)

**Files:** `src/App.tsx` (edit)

### 2.4 Update useServerPanel tests

Rename and update tests to match new hook.

**Changes to `src/hooks/__tests__/useServerPanel.test.ts`:**
- Rename file to `useProcessPanel.test.ts`
- Update imports and function references
- Add tests for new `addProcess`, `removeProcess`, `setActiveProcess` methods
- Keep existing tests for `handleServersChanged` and `handleToggleServer` bridge methods

**Files:** `src/hooks/__tests__/useServerPanel.test.ts` → `src/hooks/__tests__/useProcessPanel.test.ts` (rename + edit)

---

## Phase 3: Frontend — Sidebar Scripts Dock

### 3.1 Create `src/hooks/useScriptDiscovery.ts`

Hook to fetch and manage discovered scripts for a project.

**Create file with:**
- `useScriptDiscovery(projectDir: string | null)` hook
- State: `scripts: ScriptEntry[]`, `loading: boolean`
- Fetches `GET /api/scripts?dir={projectDir}` on mount and when dir changes
- Returns `{ scripts, loading, refresh }`

**Files:** `src/hooks/useScriptDiscovery.ts` (new)

### 3.2 Create `src/hooks/useScriptRunner.ts`

Hook to launch/stop scripts and track running processes.

**Create file with:**
- `useScriptRunner()` hook
- Polls `GET /api/scripts/processes` every 5s for status updates
- `runScript(dir, scriptName, packageDir)` — POST to `/api/scripts/run`, adds to processPanel
- `stopScript(processId)` — POST to `/api/scripts/stop`
- `runningProcesses: Map<string, ManagedProcess>` — current running scripts
- Returns `{ runningProcesses, runScript, stopScript }`

**Files:** `src/hooks/useScriptRunner.ts` (new)

### 3.3 Create `src/components/ScriptsDock.tsx`

Collapsible sidebar dock component — shows discovered scripts with status indicators and search.

**Create file with:**

**`ScriptRow` sub-component:**
- Props: `{ script: ScriptEntry, isRunning: boolean, onRun, onStop }`
- Click → start script (if not running) or stop (if running)
- Shows green dot when running
- `text-[11px]` font, consistent with sidebar styling

**`ScriptsDock` main component:**
- Props: `{ projectDir, onScriptStarted(processEntry) }`
- Uses `useScriptDiscovery(projectDir)` for script list
- State: `collapsed: boolean`, `searchQuery: string`, `showAll: Map<string, boolean>` (per directory)
- Collapsed state stored in localStorage
- Header: "Scripts" label + search icon toggle + collapse chevron
- When expanded:
  - If search active: show search input, filter all scripts by name
  - Group scripts by `dirLabel`
  - Per group: show common scripts by default, "Show all..." button to reveal others
  - Each script row with run/stop + status indicator
- Loading state: skeleton/spinner while discovering

**Styling:**
- Same elevation/border patterns as sidebar tab content
- `border-t border-border/50` at top to separate from session list
- Respect theme (dark/oled/light)

**Files:** `src/components/ScriptsDock.tsx` (new)

### 3.4 Wire ScriptsDock into SessionBrowser

Add the dock to the bottom of the sidebar, outside the tab content.

**Changes to `src/components/session-browser/SessionBrowser.tsx`:**
- Import `ScriptsDock`
- Add `projectDir` prop to `SessionBrowserProps` (the cwd of the current session/project)
- Add `onScriptStarted` prop (callback to add process to ProcessPanel)
- After the tab content `<div>`, add `<ScriptsDock>` as a sibling
- The sidebar becomes a flex column with tab content taking `flex-1` and ScriptsDock at the bottom

**Changes to `src/components/session-browser/types.ts`:**
- Add `projectDir?: string | null` to `SessionBrowserProps`
- Add `onScriptStarted?: (process: ProcessEntry) => void`

**Changes to `src/App.tsx`:**
- Pass `projectDir={state.session?.cwd ?? state.pendingCwd ?? null}` to SessionBrowser
- Pass `onScriptStarted={processPanel.addProcess}` to SessionBrowser

**Files:** `src/components/session-browser/SessionBrowser.tsx` (edit), `src/components/session-browser/types.ts` (edit), `src/App.tsx` (edit)

---

## Phase 4: Integration & Polish

### 4.1 State persistence — load previous processes on startup

**Changes to `src/hooks/useProcessPanel.ts`:**
- On mount: fetch `GET /api/scripts/processes` to load previously-known stopped processes
- Show them as "stopped" entries in the process panel for one-click restart

**Changes to `server/routes/scripts/process-manager.ts`:**
- On init: call `loadState()`, populate registry with stopped entries
- On every status change: call `saveState()`

**Files:** `src/hooks/useProcessPanel.ts` (edit), `server/routes/scripts/process-manager.ts` (edit)

### 4.2 Cleanup — remove old ServerPanel

Once ProcessPanel is fully wired and working:

- Delete `src/components/ServerPanel.tsx`
- Delete `src/hooks/useServerPanel.ts`
- Delete `src/hooks/__tests__/useServerPanel.test.ts` (if not already renamed)
- Remove any remaining imports/references

**Files:** delete `ServerPanel.tsx`, delete `useServerPanel.ts`

### 4.3 Run tests and fix

- Run `bun run test` — fix any broken tests from the refactor
- Run `bun run build` — verify no type errors
- Manually verify:
  - Scripts section appears in sidebar
  - Clicking a script starts it and shows output in bottom panel
  - Stopping a script updates UI
  - Claude-spawned tasks still appear in bottom panel
  - Session switching preserves panel state

**Files:** various test files

---

## Dependency Graph

```
1.1 (ProcessManager) ──┐
1.2 (Discovery)     ───┤
1.3 (State)         ───┼── 1.4 (Routes) ── 1.5 (Register) ──┐
                       │                                      │
                       │   2.1 (useProcessPanel) ─── 2.2 (ProcessPanel) ─── 2.3 (Wire App) ─── 2.4 (Tests)
                       │                                      │
                       │   3.1 (useScriptDiscovery) ──────────┤
                       │   3.2 (useScriptRunner) ─────────────┼── 3.3 (ScriptsDock) ── 3.4 (Wire Sidebar)
                       │                                      │
                       └──────────────────────────────────────┘
                                                              │
                                                    4.1 (Persistence) ── 4.2 (Cleanup) ── 4.3 (Tests)
```

**Parallelizable:**
- 1.1 + 1.2 + 1.3 can be done in parallel
- 2.1 + 3.1 + 3.2 can be done in parallel (after 1.5)
- 2.2 + 3.3 can be done in parallel (after their hooks)

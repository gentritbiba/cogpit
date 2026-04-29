# Script Runner & Unified Process Panel

## Overview

Add the ability to discover, launch, and monitor npm/bun scripts from any project's `package.json` (including child directories). All running processes — user-launched scripts, Claude-spawned tasks, and PTY terminals — are unified in a single bottom panel with type badges.

## Architecture

Three layers:

1. **Process Manager (backend)** — Spawns, tracks, and streams output from all process types. Single registry with status, type, origin directory, and output buffer. Persists last-known state to disk.

2. **Script Discovery (backend)** — On project load, scans root + immediate child dirs for `package.json` files. Extracts scripts, categorizes as "common" or "other".

3. **Two UI pieces (frontend):**
   - **Sidebar dock** — Collapsible section pinned to bottom of sidebar. Directory tree with status indicators and search. Click to launch/stop.
   - **Unified Process Panel** — Refactored ServerPanel. All process types in one tabbed panel with type badges.

## Data Model

```ts
interface ManagedProcess {
  id: string                    // unique, e.g. "proc_abc123"
  name: string                  // script name, e.g. "dev"
  command: string               // actual command, e.g. "vite"
  cwd: string                   // directory it runs in
  type: 'script' | 'task' | 'terminal'
  status: 'running' | 'stopped' | 'errored'
  pid?: number
  startedAt?: string
  stoppedAt?: string
  source: string                // which package.json dir (relative)
}

interface ScriptEntry {
  name: string                  // e.g. "dev"
  command: string               // e.g. "vite"
  dir: string                   // absolute path to package.json dir
  dirLabel: string              // relative label, e.g. "root/" or "packages/api/"
  isCommon: boolean             // auto-categorized
}

interface ProcessState {
  processes: ManagedProcess[]
  lastUpdated: string
}
```

## Common Scripts (shown by default)

`dev`, `start`, `build`, `test`, `serve`, `watch`, `preview`, `lint`, `typecheck`

## Script Discovery

1. Read `package.json` in project root → extract `scripts`
2. Scan immediate child dirs for `package.json` → extract `scripts` from each
3. Tag each as common/other based on name
4. Return grouped by directory with relative labels

## Sidebar Dock

Collapsible "Scripts" section pinned to bottom of sidebar, always visible regardless of active tab.

```
├─────────────────────────┤
│ ▾ Scripts           🔍  │
│   ▾ root/               │
│     dev        ● running│
│     build               │
│     test                │
│   ▾ packages/api/       │
│     dev                 │
│     start               │
│   [Show all...]         │
└─────────────────────────┘
```

- Click script name → start it, open output in bottom panel
- Click running indicator → stop the process
- Search icon → inline search field, filters all dirs and scripts
- "Show all..." → reveals non-common scripts per directory
- Section header is collapsible, state remembered
- Resizable divider between session list and Scripts section

## Unified Process Panel (replaces ServerPanel)

```
┌──────────────────────────────────────────────────┐
│ Processes                                    ▾ ▲ │
├──────────────────────────────────────────────────┤
│ [dev ● script] [api:dev ● script] [build task]   │
│                                                  │
│ > vite v5.2.0                                    │
│ > Local: http://localhost:5173/                   │
│ > ready in 423ms                                 │
└──────────────────────────────────────────────────┘
```

- Tab bar: one tab per running/recent process
- Each tab: process name + type badge (script / task / terminal)
- Running = green dot, errored = red dot in tab
- Close button: stops if running, removes from view
- Output area: stdout/stderr with ANSI color support
- Auto-scroll with scroll-to-bottom FAB (existing pattern)
- Clear output button per process
- Auto-opens on script launch, stays collapsed when nothing running

## State Persistence

- `process-state.json` in app data dir
- Written on every status change
- On restart: all entries loaded with `status: 'stopped'`
- Shows "last session" state for quick one-click restart
- No auto-restart on app launch

## Backend Routes

New route file: `server/routes/scripts.ts`

Endpoints:
- `GET /api/scripts?dir={projectDir}` — Discover scripts from package.json files
- `POST /api/scripts/run` — Start a script `{ dir, scriptName, packageDir }`
- `POST /api/scripts/stop` — Stop a running script `{ processId }`
- `GET /api/scripts/processes` — List all managed processes with status
- `GET /api/scripts/output?id={processId}` — SSE stream for process output

Registered in both `server/api-plugin.ts` and `electron/server.ts`.

## Process Management

- Scripts spawned via `child_process.spawn` with `bun run <script>` or `npm run <script>`
- Output captured via stdout/stderr streams
- Ring buffer (last 100KB) for each process
- SSE endpoint streams new output to connected clients
- Process exit updates status and notifies clients
- Multiple clients can watch same process output

## Key Decisions

- **Flat list with type badges** (not grouped by type) in bottom panel
- **Smart filter** for common scripts + search (not show-all or pin-based)
- **Remember-but-don't-restart** on app relaunch
- **Unified panel** replacing ServerPanel (not separate panels)
- **Shared state** — sidebar dock and bottom panel read from same process registry

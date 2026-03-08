# MCP Selector Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an MCP server multi-select dropdown to `ChatInputSettings` so users can choose which MCP servers are active per session, with cached status checking and localStorage persistence.

**Architecture:** New backend route shells out to `claude mcp list` (cached 2hrs) to discover servers + status. Frontend `useMcpServers` hook manages selection state in localStorage keyed by project dirName. Unselected servers are passed as `--disallowed-tools "mcp__<name>__*"` through the existing permissions/disallowedTools pipeline. Auth-required servers open system terminal with `claude /mcp`.

**Tech Stack:** React 19, TypeScript, Express (server), existing MiniDropdown portal pattern, localStorage, `child_process.execFile`

---

### Task 1: Backend — MCP servers API route

**Files:**
- Create: `server/routes/mcp.ts`
- Modify: `server/api-plugin.ts:87-109` (register route)
- Test: `server/__tests__/routes/mcp.test.ts`

**Step 1: Write the failing test**

Create `server/__tests__/routes/mcp.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// We'll test the parseMcpListOutput helper and the cache logic
// The route itself spawns `claude mcp list` — we mock execFile

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}))

import { parseMcpListOutput, getMcpServers, clearMcpCache } from "../../routes/mcp"

describe("parseMcpListOutput", () => {
  it("parses connected stdio server", () => {
    const output = "  - clickup: connected\n    type: stdio\n    command: npx -y mcp-remote https://mcp.clickup.com/mcp\n"
    const result = parseMcpListOutput(output)
    expect(result).toContainEqual({
      name: "clickup",
      status: "connected",
    })
  })

  it("parses server needing auth", () => {
    const output = "  - gmail: needs authentication\n    type: http\n    url: https://gmail.mcp.claude.com/mcp\n"
    const result = parseMcpListOutput(output)
    expect(result).toContainEqual({
      name: "gmail",
      status: "needs_auth",
    })
  })

  it("returns empty array for empty output", () => {
    expect(parseMcpListOutput("")).toEqual([])
  })
})

describe("getMcpServers", () => {
  beforeEach(() => clearMcpCache())

  it("returns cached result within TTL", async () => {
    const { execFile } = await import("node:child_process")
    const mockExec = execFile as unknown as ReturnType<typeof vi.fn>
    let callCount = 0
    mockExec.mockImplementation((_cmd: string, _args: string[], _opts: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void) => {
      callCount++
      cb(null, "  - test: connected\n")
    })

    const first = await getMcpServers("/some/path")
    const second = await getMcpServers("/some/path")
    expect(first).toEqual(second)
    expect(callCount).toBe(1) // Only called once due to cache
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun run test -- server/__tests__/routes/mcp.test.ts`
Expected: FAIL — module `../../routes/mcp` does not exist

**Step 3: Write the implementation**

Create `server/routes/mcp.ts`:

```typescript
import { execFile } from "node:child_process"
import type { UseFn } from "../helpers"

export interface McpServer {
  name: string
  status: "connected" | "needs_auth" | "error"
}

/**
 * Parse the text output of `claude mcp list` into structured server entries.
 * The output format is like:
 *   - servername: connected
 *   - other: needs authentication
 */
export function parseMcpListOutput(output: string): McpServer[] {
  const servers: McpServer[] = []
  const lines = output.split("\n")
  for (const line of lines) {
    const match = line.match(/^\s*-\s+(\S+):\s+(.+)$/)
    if (match) {
      const name = match[1]
      const rawStatus = match[2].trim().toLowerCase()
      let status: McpServer["status"] = "error"
      if (rawStatus === "connected" || rawStatus.includes("connected")) {
        status = "connected"
      } else if (rawStatus.includes("auth")) {
        status = "needs_auth"
      }
      servers.push({ name, status })
    }
  }
  return servers
}

// ── Cache ──────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours
const cache = new Map<string, { servers: McpServer[]; timestamp: number }>()

export function clearMcpCache(cwd?: string) {
  if (cwd) cache.delete(cwd)
  else cache.clear()
}

export function getMcpServers(cwd: string): Promise<McpServer[]> {
  const cached = cache.get(cwd)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return Promise.resolve(cached.servers)
  }

  return new Promise((resolve) => {
    const env = { ...process.env }
    delete env.CLAUDECODE
    execFile("claude", ["mcp", "list"], { cwd, env, timeout: 15000 }, (err, stdout) => {
      if (err) {
        resolve(cached?.servers ?? [])
        return
      }
      const servers = parseMcpListOutput(stdout)
      cache.set(cwd, { servers, timestamp: Date.now() })
      resolve(servers)
    })
  })
}

// ── Route ──────────────────────────────────────────────────────────────────
export function registerMcpRoutes(use: UseFn) {
  use("/api/mcp-servers", (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "", `http://${req.headers.host}`)
    const cwd = url.searchParams.get("cwd")
    const refresh = url.searchParams.get("refresh") === "1"

    if (!cwd) {
      res.statusCode = 400
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ error: "cwd query parameter required" }))
      return
    }

    if (refresh) clearMcpCache(cwd)

    getMcpServers(cwd).then((servers) => {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ servers }))
    })
  })
}
```

**Step 4: Run test to verify it passes**

Run: `bun run test -- server/__tests__/routes/mcp.test.ts`
Expected: PASS

**Step 5: Register the route in api-plugin.ts**

Modify `server/api-plugin.ts`. Add import at line ~19:

```typescript
import { registerMcpRoutes } from "./routes/mcp"
```

Add registration call after `registerCogpitSearchRoutes(use)` (around line 109):

```typescript
      registerMcpRoutes(use)
```

**Step 6: Register the route in electron/server.ts**

Find the route registration section and add the same import + registration call. (Same pattern as other routes.)

**Step 7: Run full tests**

Run: `bun run test`
Expected: All existing tests still pass

**Step 8: Commit**

```bash
git add server/routes/mcp.ts server/__tests__/routes/mcp.test.ts server/api-plugin.ts electron/server.ts
git commit -m "feat: add GET /api/mcp-servers route with 2hr cache"
```

---

### Task 2: Frontend hook — useMcpServers

**Files:**
- Create: `src/hooks/useMcpServers.ts`
- Test: `src/hooks/__tests__/useMcpServers.test.ts`

**Step 1: Write the failing test**

Create `src/hooks/__tests__/useMcpServers.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useMcpServers } from "../useMcpServers"

// Mock authFetch
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

import { authFetch } from "@/lib/auth"

const mockFetch = authFetch as unknown as ReturnType<typeof vi.fn>

describe("useMcpServers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it("fetches servers and auto-selects connected ones", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        servers: [
          { name: "clickup", status: "connected" },
          { name: "gmail", status: "needs_auth" },
        ],
      }),
    })

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir"))

    // Wait for fetch
    await vi.waitFor(() => {
      expect(result.current.servers.length).toBe(2)
    })

    // Connected servers auto-selected, auth ones not
    expect(result.current.selectedServers).toEqual(["clickup"])
  })

  it("persists selection to localStorage", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        servers: [
          { name: "clickup", status: "connected" },
          { name: "figma", status: "connected" },
        ],
      }),
    })

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir"))

    await vi.waitFor(() => {
      expect(result.current.servers.length).toBe(2)
    })

    // Deselect figma
    act(() => result.current.toggleServer("figma"))
    expect(result.current.selectedServers).toEqual(["clickup"])

    // Check localStorage
    const stored = JSON.parse(localStorage.getItem("cogpit:mcpSelection:test-dir") || "null")
    expect(stored).toEqual(["clickup"])
  })

  it("loads saved selection from localStorage", async () => {
    localStorage.setItem("cogpit:mcpSelection:test-dir", JSON.stringify(["figma"]))

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        servers: [
          { name: "clickup", status: "connected" },
          { name: "figma", status: "connected" },
        ],
      }),
    })

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir"))

    await vi.waitFor(() => {
      expect(result.current.servers.length).toBe(2)
    })

    // Should use stored selection, not auto-select
    expect(result.current.selectedServers).toEqual(["figma"])
  })

  it("returns disallowedMcpTools for unselected servers", async () => {
    localStorage.setItem("cogpit:mcpSelection:test-dir", JSON.stringify(["clickup"]))

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        servers: [
          { name: "clickup", status: "connected" },
          { name: "figma", status: "connected" },
        ],
      }),
    })

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir"))

    await vi.waitFor(() => {
      expect(result.current.servers.length).toBe(2)
    })

    expect(result.current.disallowedMcpTools).toEqual(["mcp__figma__*"])
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun run test -- src/hooks/__tests__/useMcpServers.test.ts`
Expected: FAIL — module `../useMcpServers` does not exist

**Step 3: Write the implementation**

Create `src/hooks/useMcpServers.ts`:

```typescript
import { useState, useEffect, useCallback, useRef } from "react"
import { authFetch } from "@/lib/auth"

export interface McpServer {
  name: string
  status: "connected" | "needs_auth" | "error"
}

const STORAGE_PREFIX = "cogpit:mcpSelection:"

function loadSavedSelection(dirName: string): string[] | null {
  try {
    const stored = localStorage.getItem(STORAGE_PREFIX + dirName)
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return null
}

function saveSelection(dirName: string, selected: string[]) {
  try {
    localStorage.setItem(STORAGE_PREFIX + dirName, JSON.stringify(selected))
  } catch { /* ignore */ }
}

export function useMcpServers(cwd: string | undefined, dirName: string | undefined) {
  const [servers, setServers] = useState<McpServer[]>([])
  const [selectedServers, setSelectedServers] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const initializedRef = useRef(false)
  const dirNameRef = useRef(dirName)
  dirNameRef.current = dirName

  // Fetch servers from backend
  useEffect(() => {
    if (!cwd) return
    initializedRef.current = false
    setLoading(true)

    authFetch(`/api/mcp-servers?cwd=${encodeURIComponent(cwd)}`)
      .then(async (res) => {
        if (!res.ok) return
        const data = await res.json()
        const fetched: McpServer[] = data.servers ?? []
        setServers(fetched)

        // Initialize selection: use saved prefs or auto-select connected
        const saved = dirNameRef.current ? loadSavedSelection(dirNameRef.current) : null
        if (saved) {
          // Filter saved to only include servers that still exist and are connected
          const connectedNames = new Set(fetched.filter(s => s.status === "connected").map(s => s.name))
          setSelectedServers(saved.filter(name => connectedNames.has(name)))
        } else {
          setSelectedServers(fetched.filter(s => s.status === "connected").map(s => s.name))
        }
        initializedRef.current = true
      })
      .catch(() => { /* ignore */ })
      .finally(() => setLoading(false))
  }, [cwd])

  const toggleServer = useCallback((name: string) => {
    setSelectedServers(prev => {
      const next = prev.includes(name)
        ? prev.filter(n => n !== name)
        : [...prev, name]
      if (dirNameRef.current) saveSelection(dirNameRef.current, next)
      return next
    })
  }, [])

  const refresh = useCallback(() => {
    if (!cwd) return
    setLoading(true)
    authFetch(`/api/mcp-servers?cwd=${encodeURIComponent(cwd)}&refresh=1`)
      .then(async (res) => {
        if (!res.ok) return
        const data = await res.json()
        setServers(data.servers ?? [])
      })
      .catch(() => { /* ignore */ })
      .finally(() => setLoading(false))
  }, [cwd])

  // Compute disallowed tools for unselected connected servers
  const disallowedMcpTools = servers
    .filter(s => s.status === "connected" && !selectedServers.includes(s.name))
    .map(s => `mcp__${s.name}__*`)

  return {
    servers,
    selectedServers,
    disallowedMcpTools,
    loading,
    toggleServer,
    refresh,
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun run test -- src/hooks/__tests__/useMcpServers.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/hooks/useMcpServers.ts src/hooks/__tests__/useMcpServers.test.ts
git commit -m "feat: add useMcpServers hook with localStorage persistence"
```

---

### Task 3: Wire MCP disallowed tools into session pipeline

**Files:**
- Modify: `src/App.tsx:231-310` (add hook + pass to usePtyChat/useNewSession)
- Modify: `src/hooks/usePtyChat.ts:8,24,125-133,161` (accept + send disallowedMcpTools)
- Modify: `src/hooks/useNewSession.ts:10,17,21,74-81,147` (accept + send disallowedMcpTools)
- Modify: `src/hooks/useAppHandlers.ts:14,24-28,32-35,209-213,216-228` (track MCP in applied settings + hasSettingsChanges)
- Modify: `server/routes/claude.ts:24,34-37,95-106` (merge disallowedMcpTools into permArgs)
- Modify: `server/routes/claude-new/sessionSpawner.ts:212,228-232,241-253` (merge disallowedMcpTools into create-and-send)

**Step 1: Add `disallowedMcpTools` to the `/api/send-message` body**

In `server/routes/claude.ts`, line 24 — destructure `disallowedMcpTools` from body:

```typescript
const { sessionId, message, images, cwd, permissions, model, effort, disallowedMcpTools } = JSON.parse(body)
```

After `const permArgs = buildPermArgs(permissions)` (line 34), add MCP disallow args:

```typescript
const mcpArgs: string[] = []
if (Array.isArray(disallowedMcpTools)) {
  for (const tool of disallowedMcpTools) {
    mcpArgs.push("--disallowedTools", tool)
  }
}
```

In the `spawn` call (line 95-106), add `...mcpArgs` after `...effortArgs`:

```typescript
...effortArgs,
...mcpArgs,
```

**Step 2: Add `disallowedMcpTools` to `/api/create-and-send` body**

In `server/routes/claude-new/sessionSpawner.ts`, line 212 — destructure `disallowedMcpTools`:

```typescript
const { dirName, message, images, permissions, model, effort, worktreeName, disallowedMcpTools } = JSON.parse(body)
```

After `const effortArgs = ...` (line 231), add:

```typescript
const mcpArgs: string[] = []
if (Array.isArray(disallowedMcpTools)) {
  for (const tool of disallowedMcpTools) {
    mcpArgs.push("--disallowedTools", tool)
  }
}
```

In the `spawn` call (line 241-253), add `...mcpArgs` after `...worktreeArgs`:

```typescript
...worktreeArgs,
...mcpArgs,
```

**Step 3: Frontend — pass `disallowedMcpTools` through `usePtyChat`**

In `src/hooks/usePtyChat.ts`:

Add to `UsePtyChatOpts` interface (after `effort?: string`):

```typescript
disallowedMcpTools?: string[]
```

Destructure it in the function signature (line 24):

```typescript
export function usePtyChat({ sessionSource, parsedSessionId, cwd, permissions, onPermissionsApplied, model, effort, disallowedMcpTools, onCreateSession }: UsePtyChatOpts) {
```

Add to the `/api/send-message` body (line 125-133):

```typescript
body: JSON.stringify({
  sessionId,
  message: text,
  images: images || undefined,
  cwd: cwd || undefined,
  permissions: permsConfig,
  model: model || undefined,
  effort: effort || undefined,
  disallowedMcpTools: disallowedMcpTools || undefined,
}),
```

Add to the dependency array (line 161):

```typescript
[sessionId, cwd, permissions, onPermissionsApplied, model, effort, disallowedMcpTools, onCreateSession]
```

**Step 4: Frontend — pass `disallowedMcpTools` through `useNewSession`**

In `src/hooks/useNewSession.ts`:

Add to `UseNewSessionOpts` (after `effort: string`):

```typescript
disallowedMcpTools?: string[]
```

Destructure it (line 28):

```typescript
disallowedMcpTools,
```

Add to the `create-and-send` body (lines 74-81):

```typescript
body: JSON.stringify({
  dirName,
  message,
  images,
  permissions: permissionsConfig,
  model: model || undefined,
  effort: effort || undefined,
  worktreeName: worktreeEnabled ? (worktreeName || slugifyWorktreeName(message)) : undefined,
  disallowedMcpTools: disallowedMcpTools || undefined,
}),
```

Add to dependency array (line 147):

```typescript
[permissionsConfig, model, effort, disallowedMcpTools, worktreeEnabled, worktreeName, dispatch, isMobile, onSessionFinalized, onCreateStarted]
```

**Step 5: Wire up in App.tsx**

In `src/App.tsx`, after the `selectedEffort` state (around line 235), add the MCP hook:

```typescript
const currentCwd = state.session?.cwd ?? pendingPath ?? undefined
const mcpData = useMcpServers(currentCwd, currentDirName ?? undefined)
```

Pass `disallowedMcpTools` to `useNewSession` (around line 249 area where it's called):

```typescript
disallowedMcpTools: mcpData.disallowedMcpTools,
```

Pass `disallowedMcpTools` to `usePtyChat` (around line 280 area where it's called):

```typescript
disallowedMcpTools: mcpData.disallowedMcpTools,
```

**Step 6: Track MCP in applied settings for `hasSettingsChanges`**

In `src/hooks/useAppHandlers.ts`:

Add to `AppHandlersDeps`:

```typescript
disallowedMcpTools: string[]
```

Add to `AppliedSettings`:

```typescript
disallowedMcpTools: string[]
```

Update `hasSettingsChanges` (line 210-213) — add MCP comparison:

```typescript
const mcpChanged = JSON.stringify(deps.disallowedMcpTools) !== JSON.stringify(applied?.disallowedMcpTools ?? [])
const hasSettingsChanges = applied != null &&
  (selectedModel !== applied.model ||
   selectedEffort !== applied.effort ||
   hasPermsPendingChanges ||
   mcpChanged)
```

Update `setAppliedSettings` in the session-change effect and `handleApplySettings` to include `disallowedMcpTools`.

**Step 7: Run full test suite**

Run: `bun run test`
Expected: All tests pass (update any existing tests that mock useAppHandlers/usePtyChat/useNewSession to include the new field)

**Step 8: Commit**

```bash
git add src/App.tsx src/hooks/usePtyChat.ts src/hooks/useNewSession.ts src/hooks/useAppHandlers.ts server/routes/claude.ts server/routes/claude-new/sessionSpawner.ts
git commit -m "feat: wire disallowedMcpTools through session create/send pipeline"
```

---

### Task 4: MCP selector UI in ChatInputSettings

**Files:**
- Modify: `src/components/ChatInput/ChatInputSettings.tsx` (add MCP button + dropdown)

**Step 1: Add MCP props to ChatInputSettingsProps**

In `src/components/ChatInput/ChatInputSettings.tsx`, add to the props interface (after `activeModelId`):

```typescript
/** MCP servers available for this project */
mcpServers?: Array<{ name: string; status: "connected" | "needs_auth" | "error" }>
/** Currently selected MCP server names */
selectedMcpServers?: string[]
/** Toggle an MCP server on/off */
onToggleMcpServer?: (name: string) => void
/** Refresh MCP server status */
onRefreshMcpServers?: () => void
/** Loading MCP status */
mcpLoading?: boolean
/** Called when a needs-auth server is clicked */
onMcpAuth?: (serverName: string) => void
```

**Step 2: Add the MCP multi-select dropdown component**

Add a new component `McpDropdown` in the same file (above the main export). This uses the same portal pattern as `MiniDropdown`:

```typescript
import { Plug, RefreshCw, Check } from "lucide-react"

interface McpDropdownProps {
  servers: Array<{ name: string; status: "connected" | "needs_auth" | "error" }>
  selected: string[]
  onToggle: (name: string) => void
  onRefresh: () => void
  loading: boolean
  onAuth: (name: string) => void
}

function McpDropdown({ servers, selected, onToggle, onRefresh, loading, onAuth }: McpDropdownProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)

  const connectedCount = servers.filter(s => s.status === "connected").length
  const selectedCount = selected.length

  useEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setMenuPos({ top: rect.top, left: rect.left })
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
          "text-muted-foreground hover:text-foreground hover:bg-white/5",
        )}
      >
        <Plug className="size-3" />
        <span className="truncate">MCPs {selectedCount}/{connectedCount}</span>
        <ChevronDown className={cn("size-3 opacity-50 transition-transform", open && "rotate-180")} />
      </button>

      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] min-w-[180px] rounded-lg border border-border/50 bg-elevation-3 py-1 depth-high animate-in fade-in-0 zoom-in-95 duration-100"
          style={{ top: menuPos.top, left: menuPos.left, transform: "translateY(-100%) translateY(-4px)" }}
        >
          {/* Header with refresh */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/30">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">MCP Servers</span>
            <button
              onClick={(e) => { e.stopPropagation(); onRefresh() }}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Refresh status"
            >
              <RefreshCw className={cn("size-3", loading && "animate-spin")} />
            </button>
          </div>

          {servers.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">
              {loading ? "Loading..." : "No MCP servers configured"}
            </div>
          )}

          {servers.map((server) => {
            const isConnected = server.status === "connected"
            const isSelected = selected.includes(server.name)

            if (!isConnected) {
              // Auth-required / error — grayed out, click opens auth
              return (
                <button
                  key={server.name}
                  onClick={() => { onAuth(server.name); setOpen(false) }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground/50 hover:bg-white/5 transition-colors"
                >
                  <span className="size-2 rounded-full bg-amber-500/60 shrink-0" />
                  <span className="truncate">{server.name}</span>
                  <span className="ml-auto text-[9px] text-amber-500/70">Needs auth</span>
                </button>
              )
            }

            return (
              <button
                key={server.name}
                onClick={() => onToggle(server.name)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-[11px] transition-colors",
                  isSelected
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                  "hover:bg-white/5",
                )}
              >
                <span className={cn("size-2 rounded-full shrink-0", isSelected ? "bg-emerald-500" : "bg-zinc-600")} />
                <span className="truncate">{server.name}</span>
                {isSelected && <Check className="size-3 ml-auto text-emerald-500" />}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}
```

**Step 3: Add the MCP dropdown to the settings bar**

In the `ChatInputSettings` return JSX, after the Effort `MiniDropdown` (and after the Worktree toggle block), add:

```typescript
{mcpServers && mcpServers.length > 0 && onToggleMcpServer && onRefreshMcpServers && onMcpAuth && (
  <>
    <span className="text-border/60 text-[10px] select-none">/</span>
    <McpDropdown
      servers={mcpServers}
      selected={selectedMcpServers ?? []}
      onToggle={(name) => {
        onToggleMcpServer(name)
        if (!isNewSession && applyRef.current) {
          setTimeout(() => applyRef.current?.(), 0)
        }
      }}
      onRefresh={onRefreshMcpServers}
      loading={mcpLoading ?? false}
      onAuth={onMcpAuth}
    />
  </>
)}
```

**Step 4: Pass MCP props from App.tsx**

In `src/App.tsx`, where `ChatInputSettings` is rendered (around line 690), add the MCP props:

```typescript
<ChatInputSettings
  selectedModel={selectedModel}
  onModelChange={setSelectedModel}
  selectedEffort={selectedEffort}
  onEffortChange={setSelectedEffort}
  isNewSession={isNewSession}
  worktreeEnabled={worktreeEnabled}
  onWorktreeEnabledChange={isNewSession ? setWorktreeEnabled : undefined}
  onApplySettings={handlers.handleApplySettings}
  activeModelId={state.session?.model}
  mcpServers={mcpData.servers}
  selectedMcpServers={mcpData.selectedServers}
  onToggleMcpServer={mcpData.toggleServer}
  onRefreshMcpServers={mcpData.refresh}
  mcpLoading={mcpData.loading}
  onMcpAuth={handleMcpAuth}
/>
```

**Step 5: Add `handleMcpAuth` in App.tsx**

Near `handleOpenTerminal` (line 152), add:

```typescript
const handleMcpAuth = useCallback((serverName: string) => {
  const projectPath = state.session?.cwd ?? pendingPath ?? undefined
  const dirName = state.sessionSource?.dirName ?? state.pendingDirName ?? state.dashboardProject ?? undefined
  if (!projectPath && !dirName) return
  authFetch("/api/open-terminal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectPath, dirName, command: "claude /mcp" }),
  }).catch(() => {})
}, [state.session?.cwd, pendingPath, state.sessionSource?.dirName, state.pendingDirName, state.dashboardProject])
```

> **Note:** The `open-terminal` endpoint currently doesn't support a `command` param. We'll add that in Task 5.

**Step 6: Run full test suite**

Run: `bun run test`
Expected: All tests pass

**Step 7: Commit**

```bash
git add src/components/ChatInput/ChatInputSettings.tsx src/App.tsx
git commit -m "feat: add MCP multi-select dropdown to ChatInputSettings"
```

---

### Task 5: Terminal command passthrough for MCP auth

**Files:**
- Modify: `server/routes/editor.ts:196-254` (add `command` param to open-terminal)

**Step 1: Modify `/api/open-terminal` to accept an optional `command`**

In `server/routes/editor.ts`, inside the `open-terminal` handler, after `const path = await resolveActionPath(parsed)` (line 208), extract the command:

```typescript
const command = typeof parsed.command === "string" ? parsed.command : undefined
```

Currently the handler opens a terminal at a directory. To pre-fill a command, modify the macOS `terminalCommand` approach. For macOS Terminal.app, we can use AppleScript. But the simplest cross-platform approach: instead of opening a bare terminal, use:

For macOS (using osascript to send a command to the terminal):

In the existing `try` block (lines 224-243), after the terminal opens, if `command` is set, write it to the terminal. The cleanest approach is to modify the spawn call to open the terminal with the command:

For Ghostty/iTerm/Terminal.app on macOS, replace the spawn with:

```typescript
if (command) {
  // Open terminal with command pre-filled
  const script = `
    tell application "${termApp}"
      activate
      if "${termApp}" is "Terminal" then
        do script "cd ${path.replace(/"/g, '\\"')} && ${command.replace(/"/g, '\\"')}" in front window
      else if "${termApp}" is "iTerm" then
        tell current window
          create tab with default profile
          tell current session
            write text "cd ${path.replace(/"/g, '\\"')} && ${command.replace(/"/g, '\\"')}"
          end tell
        end tell
      end if
    end tell`
  await openWithEditor("osascript", ["-e", script])
} else {
  // Existing behavior
  const { cmd, args } = terminalCommand(termApp, path)
  await openWithEditor(cmd, args)
}
```

**For simplicity in v1**, we can use a more universal approach — just open the terminal at the cwd and let macOS handle it. The `command` is informational for now; the user will see `claude /mcp` in the terminal title or we can copy it to clipboard.

**Simpler v1 approach:** On macOS, use `osascript` to open Terminal.app with a command:

```typescript
if (command && os === "darwin") {
  const escapedPath = path.replace(/'/g, "'\\''")
  const escapedCmd = command.replace(/'/g, "'\\''")
  const script = `tell application "Terminal" to do script "cd '${escapedPath}' && ${escapedCmd}"`
  await openWithEditor("osascript", ["-e", script])
} else {
  // existing terminal open logic
}
```

**Step 2: Run full test suite**

Run: `bun run test`
Expected: All tests pass

**Step 3: Commit**

```bash
git add server/routes/editor.ts
git commit -m "feat: add command param to open-terminal for MCP auth flow"
```

---

### Task 6: Final integration + smoke test

**Files:**
- Modify: `src/App.tsx` (final wiring review — ensure `currentDirName` is computed before `useMcpServers` call)

**Step 1: Verify the full flow**

Run: `bun run dev`

Manual checks:
1. Open a session in a project that has MCP servers configured
2. Verify `MCPs X/Y` button appears next to Model / Effort
3. Click it — dropdown shows servers with status dots
4. Toggle a connected server off → session restarts (same behavior as changing model)
5. Click a "Needs auth" server → terminal opens with `claude /mcp`
6. Click refresh icon → status reloads
7. Close and reopen the dropdown → selection persisted
8. Open a new session in same project → previous MCP selection preserved

**Step 2: Run full test suite one final time**

Run: `bun run test`
Expected: All tests pass

**Step 3: Commit any final adjustments**

```bash
git add -A
git commit -m "feat: MCP selector — final wiring and cleanup"
```

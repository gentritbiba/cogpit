# Worktree Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add git worktree integration to Cogpit — opt-in worktree isolation on session creation, sidebar indicators, backend worktree data routes, and a management panel.

**Architecture:** Backend routes shell out to `git worktree list`, `git status`, and `gh pr create`. The `--worktree` flag is appended to Claude CLI spawn args. Frontend adds a toggle to `SessionSetupPanel`, badges to `SessionBrowser`, a `useWorktrees` hook, and a `WorktreePanel` component.

**Tech Stack:** TypeScript, React, Vitest, Node child_process (spawn/execSync), git CLI, gh CLI

---

## Task 1: Add `WorktreeInfo` type and `slugifyWorktreeName` utility

**Files:**
- Modify: `server/helpers.ts`

**Step 1: Add the `WorktreeInfo` interface**

Add after the `PersistentSession` interface (after line 579):

```typescript
export interface WorktreeInfo {
  name: string
  path: string
  branch: string
  head: string
  headMessage: string
  isDirty: boolean
  commitsAhead: number
  linkedSessions: string[]
  createdAt: string
}
```

**Step 2: Add `slugifyWorktreeName` helper**

Add after the `WorktreeInfo` interface:

```typescript
/** Convert a user message into a valid worktree/branch name. */
export function slugifyWorktreeName(message: string): string {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/-$/, "")
}
```

**Step 3: Write test for slugify**

Add to `server/__tests__/helpers.test.ts`:

```typescript
import { slugifyWorktreeName } from "../helpers"

describe("slugifyWorktreeName", () => {
  it("converts message to slug", () => {
    expect(slugifyWorktreeName("Fix the auth token refresh logic")).toBe("fix-the-auth-token-refresh-logic")
  })
  it("truncates to 40 chars without trailing dash", () => {
    const long = "this is a very long message that exceeds the forty character limit easily"
    const result = slugifyWorktreeName(long)
    expect(result.length).toBeLessThanOrEqual(40)
    expect(result).not.toMatch(/-$/)
  })
  it("strips special characters", () => {
    expect(slugifyWorktreeName("Fix bug #123 (urgent!)")).toBe("fix-bug-123-urgent")
  })
})
```

**Step 4: Run tests**

Run: `bun run test -- server/__tests__/helpers.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/helpers.ts server/__tests__/helpers.test.ts
git commit -m "feat(worktree): add WorktreeInfo type and slugify helper"
```

---

## Task 2: Add `worktreeName` to PersistentSession and spawn args

**Files:**
- Modify: `server/helpers.ts:563-578`
- Modify: `server/routes/claude-new.ts:288-316`

**Step 1: Add `worktreeName` field to `PersistentSession`**

In `server/helpers.ts`, add to the `PersistentSession` interface (after `subagentWatcher` field at line 577):

```typescript
  /** Worktree name if session was created with --worktree */
  worktreeName: string | null
```

**Step 2: Update spawn in `claude-new.ts`**

In `server/routes/claude-new.ts`, extract `worktreeName` from the request body alongside existing fields at line 196:

```typescript
const { dirName, message, images, permissions, model, worktreeName } = JSON.parse(body)
```

Build worktree args before the spawn call (after `modelArgs` at line 261):

```typescript
const worktreeArgs = worktreeName ? ["--worktree", worktreeName] : []
```

Insert `...worktreeArgs` into the spawn args array (after `...modelArgs` at line 297):

```typescript
const child = spawn(
  "claude",
  [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--session-id", sessionId,
    ...permArgs,
    ...modelArgs,
    ...worktreeArgs,
  ],
  {
    cwd: projectPath,
    env: cleanEnv,
    stdio: ["pipe", "pipe", "pipe"],
  }
)
```

Add `worktreeName` to the PersistentSession object (after `subagentWatcher: null` at line 315):

```typescript
const ps: PersistentSession = {
  proc: child,
  onResult: null,
  dead: false,
  cwd: projectPath,
  permArgs,
  modelArgs,
  jsonlPath: null,
  pendingTaskCalls: new Map(),
  subagentWatcher: null,
  worktreeName: worktreeName || null,
}
```

**Step 3: Update persistent session creation in `claude.ts`**

In `server/routes/claude.ts`, add `worktreeName: null` to the PersistentSession object at line 135:

```typescript
const ps: PersistentSession = {
  proc: child,
  onResult: null,
  dead: false,
  cwd: cwd || homedir(),
  permArgs,
  modelArgs,
  jsonlPath: null,
  pendingTaskCalls: new Map(),
  subagentWatcher: null,
  worktreeName: null,
}
```

**Step 4: Run tests**

Run: `bun run test`
Expected: ALL PASS (existing tests should not break — `worktreeName` defaults to null)

**Step 5: Commit**

```bash
git add server/helpers.ts server/routes/claude-new.ts server/routes/claude.ts
git commit -m "feat(worktree): pass --worktree flag to Claude CLI spawn"
```

---

## Task 3: Backend route — `GET /api/worktrees/:dirName`

**Files:**
- Create: `server/routes/worktrees.ts`
- Modify: `server/api-plugin.ts`
- Modify: `electron/server.ts`

**Step 1: Write the route test**

Create `server/__tests__/routes/worktrees.test.ts`:

```typescript
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../helpers", () => ({
  dirs: { PROJECTS_DIR: "/tmp/test-projects" },
  isWithinDir: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
}))

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}))

import { isWithinDir, readdir, readFile } from "../../helpers"
import { execSync } from "node:child_process"
import type { UseFn, Middleware } from "../../helpers"
import { registerWorktreeRoutes } from "../../routes/worktrees"

const mockedIsWithinDir = vi.mocked(isWithinDir)
const mockedReaddir = vi.mocked(readdir)
const mockedReadFile = vi.mocked(readFile)
const mockedExecSync = vi.mocked(execSync)

function createMockReqRes(method: string, url: string, body?: string) {
  const dataHandlers: ((chunk: string) => void)[] = []
  const endHandlers: (() => void)[] = []
  let endData = ""
  let statusCode = 200
  const headers: Record<string, string> = {}
  const req = {
    method,
    url,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "data") dataHandlers.push(handler as (chunk: string) => void)
      if (event === "end") endHandlers.push(handler as () => void)
      return req
    }),
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  }
  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: vi.fn((k: string, v: string) => { headers[k] = v }),
    end: vi.fn((data?: string) => { endData = data || "" }),
    getHeader: vi.fn((k: string) => headers[k]),
    _getData: () => endData,
  }
  const fire = () => {
    if (body) dataHandlers.forEach(h => h(body))
    endHandlers.forEach(h => h())
  }
  return { req, res, fire }
}

describe("GET /api/worktrees/:dirName", () => {
  let handler: Middleware

  beforeEach(() => {
    vi.clearAllMocks()
    const routes: Record<string, Middleware> = {}
    const use: UseFn = (path: string, h: Middleware) => { routes[path] = h }
    registerWorktreeRoutes(use)
    handler = routes["/api/worktrees"]
  })

  it("returns worktree list for a project", async () => {
    mockedIsWithinDir.mockReturnValue(true)

    // git worktree list --porcelain output
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("worktree list --porcelain")) {
        return Buffer.from(
          "worktree /repo/.claude/worktrees/fix-auth\n" +
          "HEAD abc1234\n" +
          "branch refs/heads/worktree-fix-auth\n\n"
        )
      }
      if (cmd.includes("git status --porcelain")) return Buffer.from("M file.ts\n")
      if (cmd.includes("git log")) return Buffer.from("abc1234 fix auth bug\n")
      if (cmd.includes("rev-list --count")) return Buffer.from("2\n")
      return Buffer.from("")
    })

    // For session linking
    mockedReaddir.mockResolvedValue([] as any)

    const { req, res } = createMockReqRes("GET", "/fix-auth")
    const next = vi.fn()
    await handler(req as any, res as any, next)

    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res._getData())
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe("fix-auth")
    expect(data[0].isDirty).toBe(true)
    expect(data[0].branch).toBe("worktree-fix-auth")
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun run test -- server/__tests__/routes/worktrees.test.ts`
Expected: FAIL — `registerWorktreeRoutes` does not exist

**Step 3: Implement the route**

Create `server/routes/worktrees.ts`:

```typescript
import { execSync } from "node:child_process"
import { statSync } from "node:fs"
import {
  dirs,
  isWithinDir,
  readdir,
  readFile,
  join,
} from "../helpers"
import type { UseFn, WorktreeInfo } from "../helpers"

interface WorktreeRaw {
  path: string
  head: string
  branch: string
}

function parseWorktreeList(output: string): WorktreeRaw[] {
  const worktrees: WorktreeRaw[] = []
  let current: Partial<WorktreeRaw> = {}

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) }
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length)
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "")
    } else if (line === "" && current.path) {
      if (current.branch?.startsWith("worktree-")) {
        worktrees.push(current as WorktreeRaw)
      }
      current = {}
    }
  }
  return worktrees
}

function resolveProjectPath(dirName: string): string {
  return "/" + dirName.replace(/^-/, "").replace(/-/g, "/")
}

function getGitRoot(projectPath: string): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd: projectPath,
      encoding: "utf-8",
    }).trim()
  } catch {
    return null
  }
}

function getDefaultBranch(gitRoot: string): string {
  try {
    const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd: gitRoot,
      encoding: "utf-8",
    }).trim()
    return ref.replace("refs/remotes/origin/", "")
  } catch {
    return "main"
  }
}

export function registerWorktreeRoutes(use: UseFn) {
  // GET /api/worktrees/:dirName — list worktrees for a project
  use("/api/worktrees", async (req, res, next) => {
    const url = new URL(req.url || "/", "http://localhost")
    const pathParts = url.pathname.split("/").filter(Boolean)

    if (req.method === "GET" && pathParts.length === 1) {
      const dirName = decodeURIComponent(pathParts[0])
      const projectDir = join(dirs.PROJECTS_DIR, dirName)

      if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: "Access denied" }))
        return
      }

      const projectPath = resolveProjectPath(dirName)
      const gitRoot = getGitRoot(projectPath)

      if (!gitRoot) {
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify([]))
        return
      }

      try {
        const rawOutput = execSync("git worktree list --porcelain", {
          cwd: gitRoot,
          encoding: "utf-8",
        })

        const rawWorktrees = parseWorktreeList(rawOutput)
        const defaultBranch = getDefaultBranch(gitRoot)

        // Load session metadata for linking
        const sessionBranches = new Map<string, string[]>()
        try {
          const files = await readdir(projectDir)
          for (const f of files.filter((f: string) => f.endsWith(".jsonl"))) {
            try {
              const content = await readFile(join(projectDir, f), "utf-8")
              const firstLine = content.split("\n")[0]
              if (firstLine) {
                const parsed = JSON.parse(firstLine)
                if (parsed.gitBranch) {
                  const sessionId = f.replace(".jsonl", "")
                  const existing = sessionBranches.get(parsed.gitBranch) || []
                  existing.push(sessionId)
                  sessionBranches.set(parsed.gitBranch, existing)
                }
              }
            } catch { continue }
          }
        } catch { /* project dir may not exist */ }

        const worktrees: WorktreeInfo[] = rawWorktrees.map((wt) => {
          const name = wt.branch.replace("worktree-", "")

          let isDirty = false
          try {
            const status = execSync("git status --porcelain", {
              cwd: wt.path,
              encoding: "utf-8",
            })
            isDirty = status.trim().length > 0
          } catch { /* */ }

          let commitsAhead = 0
          try {
            const count = execSync(
              `git rev-list --count ${defaultBranch}..HEAD`,
              { cwd: wt.path, encoding: "utf-8" }
            )
            commitsAhead = parseInt(count.trim(), 10) || 0
          } catch { /* */ }

          let headMessage = ""
          try {
            headMessage = execSync("git log -1 --format=%s", {
              cwd: wt.path,
              encoding: "utf-8",
            }).trim()
          } catch { /* */ }

          let createdAt = ""
          try {
            const stat = statSync(wt.path)
            createdAt = stat.birthtime.toISOString()
          } catch { /* */ }

          return {
            name,
            path: wt.path,
            branch: wt.branch,
            head: wt.head?.slice(0, 7) || "",
            headMessage,
            isDirty,
            commitsAhead,
            linkedSessions: sessionBranches.get(wt.branch) || [],
            createdAt,
          }
        })

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify(worktrees))
      } catch {
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify([]))
      }
      return
    }

    // DELETE /api/worktrees/:dirName/:worktreeName
    if (req.method === "DELETE" && pathParts.length === 2) {
      const dirName = decodeURIComponent(pathParts[0])
      const worktreeName = decodeURIComponent(pathParts[1])

      const projectDir = join(dirs.PROJECTS_DIR, dirName)
      if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: "Access denied" }))
        return
      }

      const projectPath = resolveProjectPath(dirName)
      const gitRoot = getGitRoot(projectPath)

      if (!gitRoot) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Not a git repository" }))
        return
      }

      const body = await new Promise<string>((resolve) => {
        let data = ""
        req.on("data", (chunk: string) => { data += chunk })
        req.on("end", () => resolve(data))
      })

      const { force } = body ? JSON.parse(body) : { force: false }
      const worktreePath = join(gitRoot, ".claude", "worktrees", worktreeName)
      const branchName = `worktree-${worktreeName}`

      try {
        const removeArgs = force ? "--force" : ""
        execSync(`git worktree remove ${removeArgs} "${worktreePath}"`, {
          cwd: gitRoot,
          encoding: "utf-8",
        })

        try {
          const deleteFlag = force ? "-D" : "-d"
          execSync(`git branch ${deleteFlag} "${branchName}"`, {
            cwd: gitRoot,
            encoding: "utf-8",
          })
        } catch { /* branch may already be gone */ }

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.statusCode = 400
        res.end(JSON.stringify({
          error: `Failed to remove worktree: ${err instanceof Error ? err.message : "unknown"}`,
        }))
      }
      return
    }

    // POST /api/worktrees/:dirName/create-pr
    if (req.method === "POST" && pathParts.length === 2 && pathParts[1] === "create-pr") {
      const dirName = decodeURIComponent(pathParts[0])

      const projectDir = join(dirs.PROJECTS_DIR, dirName)
      if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: "Access denied" }))
        return
      }

      const projectPath = resolveProjectPath(dirName)
      const gitRoot = getGitRoot(projectPath)

      if (!gitRoot) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Not a git repository" }))
        return
      }

      const body = await new Promise<string>((resolve) => {
        let data = ""
        req.on("data", (chunk: string) => { data += chunk })
        req.on("end", () => resolve(data))
      })

      const { worktreeName, title, body: prBody } = JSON.parse(body)
      const worktreePath = join(gitRoot, ".claude", "worktrees", worktreeName)
      const branchName = `worktree-${worktreeName}`

      try {
        // Push branch
        execSync(`git push -u origin "${branchName}"`, {
          cwd: worktreePath,
          encoding: "utf-8",
        })

        // Create PR
        const prTitle = title || worktreeName.replace(/-/g, " ")
        const prBodyArg = prBody ? `--body "${prBody.replace(/"/g, '\\"')}"` : ""
        const prUrl = execSync(
          `gh pr create --title "${prTitle}" ${prBodyArg} --head "${branchName}"`,
          { cwd: worktreePath, encoding: "utf-8" }
        ).trim()

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ url: prUrl }))
      } catch (err) {
        res.statusCode = 400
        res.end(JSON.stringify({
          error: `Failed to create PR: ${err instanceof Error ? err.message : "unknown"}`,
        }))
      }
      return
    }

    // POST /api/worktrees/:dirName/cleanup
    if (req.method === "POST" && pathParts.length === 2 && pathParts[1] === "cleanup") {
      const dirName = decodeURIComponent(pathParts[0])

      const projectDir = join(dirs.PROJECTS_DIR, dirName)
      if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: "Access denied" }))
        return
      }

      const projectPath = resolveProjectPath(dirName)
      const gitRoot = getGitRoot(projectPath)

      if (!gitRoot) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Not a git repository" }))
        return
      }

      const body = await new Promise<string>((resolve) => {
        let data = ""
        req.on("data", (chunk: string) => { data += chunk })
        req.on("end", () => resolve(data))
      })

      const { confirm, names, maxAgeDays = 7 } = body ? JSON.parse(body) : {}

      try {
        const rawOutput = execSync("git worktree list --porcelain", {
          cwd: gitRoot,
          encoding: "utf-8",
        })
        const rawWorktrees = parseWorktreeList(rawOutput)
        const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000

        const stale = rawWorktrees.filter((wt) => {
          const name = wt.branch.replace("worktree-", "")
          try {
            const status = execSync("git status --porcelain", {
              cwd: wt.path,
              encoding: "utf-8",
            })
            if (status.trim().length > 0) return false
            const stat = statSync(wt.path)
            return stat.birthtime.getTime() < cutoff
          } catch {
            return false
          }
        })

        if (!confirm) {
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({
            stale: stale.map((wt) => ({
              name: wt.branch.replace("worktree-", ""),
              path: wt.path,
              branch: wt.branch,
            })),
          }))
          return
        }

        // Perform cleanup on confirmed names
        const namesToRemove = new Set(names || stale.map((wt) => wt.branch.replace("worktree-", "")))
        const removed: string[] = []
        const errors: string[] = []

        for (const wt of stale) {
          const name = wt.branch.replace("worktree-", "")
          if (!namesToRemove.has(name)) continue
          try {
            execSync(`git worktree remove "${wt.path}"`, { cwd: gitRoot, encoding: "utf-8" })
            try {
              execSync(`git branch -d "${wt.branch}"`, { cwd: gitRoot, encoding: "utf-8" })
            } catch { /* */ }
            removed.push(name)
          } catch (err) {
            errors.push(`${name}: ${err instanceof Error ? err.message : "unknown"}`)
          }
        }

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ removed, errors }))
      } catch {
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ stale: [] }))
      }
      return
    }

    next()
  })
}
```

**Step 4: Register the routes**

In `server/api-plugin.ts`, add import and registration (follow existing pattern):

```typescript
import { registerWorktreeRoutes } from "./routes/worktrees"
// ... in configureServer:
registerWorktreeRoutes(use)
```

In `electron/server.ts`, add the same import and registration:

```typescript
import { registerWorktreeRoutes } from "../server/routes/worktrees"
// ... after other registrations:
registerWorktreeRoutes(use)
```

**Step 5: Run tests**

Run: `bun run test -- server/__tests__/routes/worktrees.test.ts`
Expected: PASS

Run: `bun run test`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add server/routes/worktrees.ts server/__tests__/routes/worktrees.test.ts server/api-plugin.ts electron/server.ts
git commit -m "feat(worktree): add backend routes for worktree management"
```

---

## Task 4: Frontend — `useWorktrees` hook

**Files:**
- Create: `src/hooks/useWorktrees.ts`
- Create: `src/hooks/__tests__/useWorktrees.test.ts`

**Step 1: Write the test**

Create `src/hooks/__tests__/useWorktrees.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

import { authFetch } from "@/lib/auth"
import { useWorktrees } from "../useWorktrees"

const mockedAuthFetch = vi.mocked(authFetch)

describe("useWorktrees", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("fetches worktrees for a dirName", async () => {
    const mockWorktrees = [
      { name: "fix-auth", branch: "worktree-fix-auth", isDirty: true, commitsAhead: 2 },
    ]

    mockedAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockWorktrees),
    } as any)

    const { result } = renderHook(() => useWorktrees("my-project"))

    await waitFor(() => {
      expect(result.current.worktrees).toEqual(mockWorktrees)
    })

    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it("returns empty array when dirName is null", () => {
    const { result } = renderHook(() => useWorktrees(null))
    expect(result.current.worktrees).toEqual([])
    expect(result.current.loading).toBe(false)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun run test -- src/hooks/__tests__/useWorktrees.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the hook**

Create `src/hooks/useWorktrees.ts`:

```typescript
import { useState, useEffect, useCallback, useRef } from "react"
import { authFetch } from "@/lib/auth"
import type { WorktreeInfo } from "../../server/helpers"

const POLL_INTERVAL = 30_000

export function useWorktrees(dirName: string | null) {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchWorktrees = useCallback(async () => {
    if (!dirName) return
    try {
      setLoading(true)
      const res = await authFetch(`/api/worktrees/${encodeURIComponent(dirName)}`)
      if (res.ok) {
        const data = await res.json()
        setWorktrees(data)
        setError(null)
      } else {
        setError("Failed to fetch worktrees")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }, [dirName])

  useEffect(() => {
    if (!dirName) {
      setWorktrees([])
      setLoading(false)
      return
    }

    fetchWorktrees()
    intervalRef.current = setInterval(fetchWorktrees, POLL_INTERVAL)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [dirName, fetchWorktrees])

  return { worktrees, loading, error, refetch: fetchWorktrees }
}
```

**Step 4: Run tests**

Run: `bun run test -- src/hooks/__tests__/useWorktrees.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/hooks/useWorktrees.ts src/hooks/__tests__/useWorktrees.test.ts
git commit -m "feat(worktree): add useWorktrees hook with polling"
```

---

## Task 5: Frontend — Worktree toggle in `SessionSetupPanel`

**Files:**
- Modify: `src/components/SessionSetupPanel.tsx`
- Modify: `src/hooks/useNewSession.ts`
- Modify: `src/hooks/__tests__/useNewSession.test.ts`
- Modify: `src/App.tsx`

**Step 1: Add `worktreeName` to `useNewSession`**

In `src/hooks/useNewSession.ts`:

- Add `worktreeEnabled` and `worktreeName` state:

```typescript
const [worktreeEnabled, setWorktreeEnabled] = useState(false)
const [worktreeName, setWorktreeName] = useState("")
```

- Import `slugifyWorktreeName` from server helpers (or duplicate the 5-line function in a frontend util to avoid importing server code):

Add to `src/lib/utils.ts`:

```typescript
export function slugifyWorktreeName(message: string): string {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/-$/, "")
}
```

- In `createAndSend`, pass `worktreeName` to the API if worktree is enabled. Modify the `body: JSON.stringify({...})` block at line 65:

```typescript
body: JSON.stringify({
  dirName,
  message,
  images,
  permissions: permissionsConfig,
  model: model || undefined,
  worktreeName: worktreeEnabled ? (worktreeName || slugifyWorktreeName(message)) : undefined,
}),
```

- Return the new state and setters from the hook:

```typescript
return {
  creatingSession,
  createError,
  clearCreateError,
  handleNewSession,
  createAndSend,
  pendingDirNameRef,
  worktreeEnabled,
  setWorktreeEnabled,
  worktreeName,
  setWorktreeName,
}
```

**Step 2: Update `SessionSetupPanel` to include worktree toggle**

In `src/components/SessionSetupPanel.tsx`, add new props and a worktree section:

```typescript
import { Cpu, GitBranch } from "lucide-react"
import { cn, MODEL_OPTIONS, slugifyWorktreeName } from "@/lib/utils"
import { useState } from "react"

interface SessionSetupPanelProps {
  permissionsPanel?: React.ReactNode
  selectedModel?: string
  onModelChange?: (model: string) => void
  worktreeEnabled?: boolean
  onWorktreeEnabledChange?: (enabled: boolean) => void
  worktreeName?: string
  onWorktreeNameChange?: (name: string) => void
}
```

Add worktree section after the Model section, inside the `flex flex-col gap-6` container:

```tsx
{/* Worktree */}
{onWorktreeEnabledChange && (
  <div className="rounded-lg border border-border p-3">
    <section>
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <span className="h-3.5 w-0.5 rounded-full bg-emerald-500/40" />
        <GitBranch className="size-3" />
        Worktree
      </h3>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={worktreeEnabled}
          onChange={(e) => onWorktreeEnabledChange(e.target.checked)}
          className="rounded border-border"
        />
        <span className="text-xs text-foreground">Isolate in worktree</span>
      </label>
      {worktreeEnabled && (
        <input
          type="text"
          value={worktreeName}
          onChange={(e) => onWorktreeNameChange?.(e.target.value)}
          placeholder="Auto-generated from message"
          className="mt-2 w-full rounded-md border border-border bg-elevation-1 px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground"
        />
      )}
    </section>
  </div>
)}
```

**Step 3: Wire up in `App.tsx`**

Find the `<SessionSetupPanel>` usage (line 825) and pass the new props:

```tsx
<SessionSetupPanel
  permissionsPanel={permissionsPanelNode}
  selectedModel={selectedModel}
  onModelChange={setSelectedModel}
  worktreeEnabled={newSession.worktreeEnabled}
  onWorktreeEnabledChange={newSession.setWorktreeEnabled}
  worktreeName={newSession.worktreeName}
  onWorktreeNameChange={newSession.setWorktreeName}
/>
```

(Where `newSession` is the object returned by `useNewSession` — check how the existing props are destructured and adjust accordingly.)

**Step 4: Update useNewSession test**

Add to `src/hooks/__tests__/useNewSession.test.ts`:

```typescript
it("passes worktreeName in createAndSend when worktree is enabled", async () => {
  // ... set up authFetch mock for create-and-send
  // ... assert the request body includes worktreeName
})
```

**Step 5: Run tests**

Run: `bun run test`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/components/SessionSetupPanel.tsx src/hooks/useNewSession.ts src/hooks/__tests__/useNewSession.test.ts src/lib/utils.ts src/App.tsx
git commit -m "feat(worktree): add worktree toggle to session creation UI"
```

---

## Task 6: Sidebar worktree badges in `SessionBrowser`

**Files:**
- Modify: `src/components/SessionBrowser.tsx`

**Step 1: Add worktree badge to session cards**

In `SessionBrowser.tsx`, find the meta row (around line 659-677) where `gitBranch` is displayed. Modify the `gitBranch` display to detect worktree branches and render them distinctly:

```tsx
{s.gitBranch && (
  <span className="flex items-center gap-0.5">
    <GitBranch className="size-2.5" />
    {s.gitBranch.startsWith("worktree-") ? (
      <span className="inline-flex items-center gap-1">
        <span className="rounded bg-emerald-500/10 text-emerald-400 px-1 py-px text-[9px] font-medium">
          {s.gitBranch.replace("worktree-", "")}
        </span>
      </span>
    ) : (
      s.gitBranch
    )}
  </span>
)}
```

This uses the existing `gitBranch` data — no new API calls needed. The `worktree-` prefix detection is purely cosmetic.

**Step 2: Run tests**

Run: `bun run test`
Expected: ALL PASS (no logic changes that would break tests)

**Step 3: Commit**

```bash
git add src/components/SessionBrowser.tsx
git commit -m "feat(worktree): add worktree badges to session sidebar"
```

---

## Task 7: Worktree Management Panel

**Files:**
- Create: `src/components/WorktreePanel.tsx`
- Modify: `src/App.tsx`

**Step 1: Create the panel component**

Create `src/components/WorktreePanel.tsx`:

```tsx
import { useState } from "react"
import {
  GitBranch,
  Trash2,
  GitPullRequest,
  ExternalLink,
  RefreshCw,
  Sparkles,
  AlertTriangle,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn, formatRelativeTime } from "@/lib/utils"
import { authFetch } from "@/lib/auth"
import type { WorktreeInfo } from "../../server/helpers"

interface WorktreePanelProps {
  worktrees: WorktreeInfo[]
  loading: boolean
  dirName: string | null
  onRefetch: () => void
  onOpenSession: (sessionId: string) => void
}

export function WorktreePanel({
  worktrees,
  loading,
  dirName,
  onRefetch,
  onOpenSession,
}: WorktreePanelProps) {
  const [deleting, setDeleting] = useState<string | null>(null)
  const [creatingPr, setCreatingPr] = useState<string | null>(null)
  const [cleaningUp, setCleaningUp] = useState(false)

  const handleDelete = async (wt: WorktreeInfo) => {
    if (!dirName) return
    const force = wt.isDirty
    if (wt.isDirty && !confirm(`"${wt.name}" has uncommitted changes. Delete anyway?`)) return
    if (wt.commitsAhead > 0 && !confirm(`"${wt.name}" has ${wt.commitsAhead} unpushed commit(s). Delete anyway?`)) return

    setDeleting(wt.name)
    try {
      await authFetch(`/api/worktrees/${encodeURIComponent(dirName)}/${encodeURIComponent(wt.name)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      })
      onRefetch()
    } catch { /* */ }
    setDeleting(null)
  }

  const handleCreatePr = async (wt: WorktreeInfo) => {
    if (!dirName) return
    setCreatingPr(wt.name)
    try {
      const res = await authFetch(`/api/worktrees/${encodeURIComponent(dirName)}/create-pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          worktreeName: wt.name,
          title: wt.name.replace(/-/g, " "),
        }),
      })
      if (res.ok) {
        const { url } = await res.json()
        window.open(url, "_blank")
      }
    } catch { /* */ }
    setCreatingPr(null)
  }

  const handleCleanup = async () => {
    if (!dirName) return
    setCleaningUp(true)
    try {
      // First: get stale list
      const listRes = await authFetch(`/api/worktrees/${encodeURIComponent(dirName)}/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      if (listRes.ok) {
        const { stale } = await listRes.json()
        if (stale.length === 0) {
          alert("No stale worktrees found.")
        } else if (confirm(`Remove ${stale.length} stale worktree(s)?\n\n${stale.map((s: any) => s.name).join("\n")}`)) {
          await authFetch(`/api/worktrees/${encodeURIComponent(dirName)}/cleanup`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirm: true, names: stale.map((s: any) => s.name) }),
          })
          onRefetch()
        }
      }
    } catch { /* */ }
    setCleaningUp(false)
  }

  if (!dirName) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a project to view worktrees
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h2 className="text-sm font-medium flex items-center gap-2">
          <GitBranch className="size-4" />
          Worktrees
        </h2>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCleanup}
            disabled={cleaningUp}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-elevation-1 transition-colors"
            title="Cleanup stale worktrees"
          >
            <Sparkles className="size-3.5" />
          </button>
          <button
            onClick={onRefetch}
            disabled={loading}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-elevation-1 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {worktrees.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <GitBranch className="size-8 mb-2 opacity-40" />
            <p className="text-sm">No worktrees</p>
            <p className="text-xs mt-1">Create a new session with "Isolate in worktree" enabled</p>
          </div>
        )}

        {worktrees.map((wt) => (
          <div
            key={wt.name}
            className="rounded-lg border border-border p-3 hover:bg-elevation-1 transition-colors"
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">{wt.name}</span>
                {wt.isDirty && (
                  <span className="flex h-2 w-2 rounded-full bg-amber-400" title="Has uncommitted changes" />
                )}
                {wt.commitsAhead > 0 && (
                  <Badge variant="outline" className="h-4 px-1 text-[9px]">
                    {wt.commitsAhead} ahead
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1">
                {wt.linkedSessions.length > 0 && (
                  <button
                    onClick={() => onOpenSession(wt.linkedSessions[0])}
                    className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-elevation-2 transition-colors"
                    title="Open session"
                  >
                    <ExternalLink className="size-3.5" />
                  </button>
                )}
                <button
                  onClick={() => handleCreatePr(wt)}
                  disabled={creatingPr === wt.name || wt.commitsAhead === 0}
                  className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-elevation-2 transition-colors disabled:opacity-30"
                  title="Create PR"
                >
                  <GitPullRequest className="size-3.5" />
                </button>
                <button
                  onClick={() => handleDelete(wt)}
                  disabled={deleting === wt.name}
                  className="rounded p-1 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
                  title="Delete worktree"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className="font-mono">{wt.head}</span>
              <span className="truncate">{wt.headMessage}</span>
            </div>

            {wt.createdAt && (
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {formatRelativeTime(wt.createdAt)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
```

**Step 2: Add panel toggle to App.tsx**

Add state for showing the worktree panel, the `useWorktrees` hook, and render the panel. Follow the same pattern as `StatsPanel` — a toggleable right-side panel.

In `App.tsx`:

1. Import: `import { WorktreePanel } from "@/components/WorktreePanel"` and `import { useWorktrees } from "@/hooks/useWorktrees"`
2. Add state: `const [showWorktrees, setShowWorktrees] = useState(false)`
3. Get dirName from current session or pending: `const currentDirName = state.sessionSource?.dirName || state.pendingDirName || state.dashboardProject`
4. Call hook: `const worktreeData = useWorktrees(showWorktrees ? currentDirName : null)`
5. Add toggle button to `DesktopHeader` props or add a `<GitBranch>` icon button near the Stats toggle
6. Render panel after `StatsPanel`:

```tsx
{showWorktrees && (
  <WorktreePanel
    worktrees={worktreeData.worktrees}
    loading={worktreeData.loading}
    dirName={currentDirName}
    onRefetch={worktreeData.refetch}
    onOpenSession={(sessionId) => {
      // Find session by ID and navigate to it
      // Use existing session selection logic
    }}
  />
)}
```

**Step 3: Run tests**

Run: `bun run test`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add src/components/WorktreePanel.tsx src/App.tsx
git commit -m "feat(worktree): add worktree management panel"
```

---

## Task 8: Final integration test and cleanup

**Step 1: Run full test suite**

Run: `bun run test`
Expected: ALL PASS

**Step 2: Run build**

Run: `bun run build`
Expected: Build succeeds with no type errors

**Step 3: Manual smoke test checklist**

1. Start dev server: `bun run dev`
2. Open a project that is a git repo
3. Click "New Session" — verify "Worktree" section appears in SessionSetupPanel
4. Enable the worktree toggle — verify name input appears
5. Type a message and send — verify Claude spawns with `--worktree` flag
6. Check sidebar — verify the worktree badge appears on the session card
7. Open Worktree panel — verify the worktree appears in the list
8. Test "Create PR" button (if repo has a remote)
9. Test "Delete" button — verify confirmation dialog appears
10. Test "Cleanup" button

**Step 4: Commit any fixes**

```bash
git add -u
git commit -m "fix(worktree): address integration issues"
```

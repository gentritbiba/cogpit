# Worktree V2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert WorktreePanel to a slide-over sheet with file change previews and fix the worktree-session path normalization bug.

**Architecture:** Add a Sheet UI component (Radix Dialog-based), enhance the backend GET endpoint with `changedFiles` data and `--git-common-dir` path normalization, redesign WorktreePanel cards with collapsible file change lists.

**Tech Stack:** TypeScript, React, Radix UI Dialog/Collapsible, Tailwind CSS, Vitest, git CLI (read-only)

---

## Task 1: Create Sheet UI component

**Files:**
- Create: `src/components/ui/sheet.tsx`

**Step 1: Create the Sheet component**

Built on `@radix-ui/react-dialog` (already installed). Follow exact same patterns as `src/components/ui/dialog.tsx` — same overlay style, same animation conventions.

Create `src/components/ui/sheet.tsx`:

```tsx
import * as React from "react"
import * as SheetPrimitive from "@radix-ui/react-dialog"
import { XIcon } from "lucide-react"
import { cn } from "@/lib/utils"

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetPortal({ ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]",
        className
      )}
      {...props}
    />
  )
}

function SheetContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content>) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "elevation-4 text-foreground fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-[560px] flex-col border-l border-border/40 duration-300",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
          className
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close className="absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-2 p-4 border-b border-border", className)}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-sm font-medium", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
}
```

**Step 2: Run build to verify no type errors**

Run: `bun run build`
Expected: Build succeeds (new component is not used yet)

**Step 3: Commit**

```bash
git add src/components/ui/sheet.tsx
git commit -m "feat(worktree): add Sheet UI component"
```

---

## Task 2: Fix worktree path normalization bug

**Files:**
- Modify: `server/routes/worktrees.ts:73-82` (replace `getGitRoot`)
- Modify: `server/__tests__/routes/worktrees.test.ts`

**Step 1: Write test for the fix**

In `server/__tests__/routes/worktrees.test.ts`, add a new test inside the `GET /api/worktrees/:dirName` describe block. This test verifies that when `resolveProjectPath` returns a worktree directory, the backend still finds all worktrees by normalizing to the main repo root:

```typescript
it("normalizes worktree cwd to main repo root via --git-common-dir", async () => {
  mockedIsWithinDir.mockReturnValue(true)

  // resolveProjectPath will read a session JSONL whose cwd is a worktree dir
  const mockFh = { read: vi.fn().mockResolvedValue({ bytesRead: 100 }), close: vi.fn() }
  const cwdJson = JSON.stringify({ cwd: "/repo/.claude/worktrees/fix-auth" })
  mockFh.read.mockImplementation((_buf: Buffer) => {
    const b = Buffer.from(cwdJson + "\n")
    b.copy(_buf)
    return Promise.resolve({ bytesRead: b.length })
  })
  const { open } = await import("../../helpers")
  vi.mocked(open).mockResolvedValue(mockFh as any)
  mockedReaddir.mockResolvedValue(["session1.jsonl"] as any)

  mockedExecSync.mockImplementation((cmd: string) => {
    // --git-common-dir from worktree returns path to main .git
    if (cmd.includes("git-common-dir")) return "/repo/.git\n"
    if (cmd.includes("symbolic-ref")) throw new Error("no remote")
    if (cmd.includes("worktree list --porcelain")) {
      return (
        "worktree /repo/.claude/worktrees/fix-auth\n" +
        "HEAD abc1234\n" +
        "branch refs/heads/worktree-fix-auth\n\n"
      )
    }
    return ""
  })

  mockedExecFileSync.mockImplementation((cmd: unknown, args: unknown) => {
    const a = args as string[]
    if (cmd === "git" && a.includes("status")) return ""
    if (cmd === "git" && a.includes("rev-list")) return "1\n"
    if (cmd === "git" && a.includes("log")) return "fix auth\n"
    if (cmd === "git" && a.includes("diff")) return ""
    return ""
  })

  const { req, res } = createMockReqRes("GET", "/test-project")
  const next = vi.fn()
  await handler(req as any, res as any, next)

  expect(res.statusCode).toBe(200)
  const data = JSON.parse(res._getData())
  expect(data).toHaveLength(1)
  expect(data[0].name).toBe("fix-auth")

  // Verify --git-common-dir was called (not --show-toplevel)
  expect(mockedExecSync).toHaveBeenCalledWith(
    expect.stringContaining("git-common-dir"),
    expect.any(Object)
  )
})
```

**Step 2: Run test to verify it fails**

Run: `bun run test -- server/__tests__/routes/worktrees.test.ts`
Expected: FAIL — `getGitRoot` still uses `--show-toplevel`, not `--git-common-dir`

**Step 3: Replace `getGitRoot` with `getMainWorktreeRoot`**

In `server/routes/worktrees.ts`, add `import { resolve, dirname } from "node:path"` at the top, then replace the `getGitRoot` function (lines 73-82):

Replace:

```typescript
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
```

With:

```typescript
function getMainWorktreeRoot(projectPath: string): string | null {
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", {
      cwd: projectPath,
      encoding: "utf-8",
    }).trim()
    // --git-common-dir returns the path to the shared .git directory.
    // From main repo: ".git" (relative). From worktree: absolute or relative path to main .git.
    // Resolving it and taking dirname gives the main repo root.
    return dirname(resolve(projectPath, commonDir))
  } catch {
    return null
  }
}
```

Then replace all 4 calls to `getGitRoot(` with `getMainWorktreeRoot(` in the file (lines 113, 228, 283, 353).

**Step 4: Run tests**

Run: `bun run test -- server/__tests__/routes/worktrees.test.ts`
Expected: PASS

Note: The existing test mocks `execSync` for `rev-parse --show-toplevel`. Update those mocks to match `git-common-dir` instead. In the `returns worktree list` test (line 97), change:

```typescript
if (cmd.includes("rev-parse --show-toplevel")) return "/repo"
```

to:

```typescript
if (cmd.includes("git-common-dir")) return "/repo/.git\n"
```

Do the same for all other tests in the file that mock `rev-parse --show-toplevel` (there are 5 occurrences: lines 97, 136, 201, 231, 249, 271).

**Step 5: Run full test suite**

Run: `bun run test`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add server/routes/worktrees.ts server/__tests__/routes/worktrees.test.ts
git commit -m "fix(worktree): normalize worktree path via --git-common-dir"
```

---

## Task 3: Add `changedFiles` to backend response

**Files:**
- Modify: `server/helpers.ts:583-593` (add `FileChange` type to `WorktreeInfo`)
- Modify: `server/routes/worktrees.ts:151-198` (collect file changes per worktree)
- Modify: `server/__tests__/routes/worktrees.test.ts`

**Step 1: Add `FileChange` interface and update `WorktreeInfo`**

In `server/helpers.ts`, add the `FileChange` interface after `WorktreeInfo` and add the field:

```typescript
export interface FileChange {
  path: string
  status: "M" | "A" | "D" | "R"
  additions: number
  deletions: number
}

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
  changedFiles: FileChange[]
}
```

**Step 2: Update test to expect `changedFiles`**

In `server/__tests__/routes/worktrees.test.ts`, in the `returns worktree list` test, add the `git diff --numstat` mock and assertion:

Add to `mockedExecFileSync` implementation:

```typescript
if (cmd === "git" && a[0] === "diff" && a.includes("--numstat")) return "10\t2\tsrc/auth.ts\n3\t0\tsrc/types.ts\n"
```

Add assertion:

```typescript
expect(data[0].changedFiles).toEqual([
  { path: "src/auth.ts", status: "M", additions: 10, deletions: 2 },
  { path: "src/types.ts", status: "M", additions: 3, deletions: 0 },
])
```

**Step 3: Run test to verify it fails**

Run: `bun run test -- server/__tests__/routes/worktrees.test.ts`
Expected: FAIL — `changedFiles` is undefined

**Step 4: Implement file change collection**

In `server/routes/worktrees.ts`, inside the `rawWorktrees.map()` callback (around line 151), after collecting `createdAt`, add:

```typescript
let changedFiles: Array<{ path: string; status: "M" | "A" | "D" | "R"; additions: number; deletions: number }> = []
try {
  // Get diff stats against default branch
  const diffOutput = execFileSync(
    "git",
    ["diff", "--numstat", `${defaultBranch}..HEAD`],
    { cwd: wt.path, encoding: "utf-8" }
  )
  // Also get uncommitted changes
  const uncommittedOutput = execFileSync(
    "git",
    ["diff", "--numstat"],
    { cwd: wt.path, encoding: "utf-8" }
  )

  const seen = new Set<string>()
  for (const output of [diffOutput, uncommittedOutput]) {
    for (const line of output.trim().split("\n")) {
      if (!line) continue
      const [add, del, filePath] = line.split("\t")
      if (!filePath || seen.has(filePath)) continue
      seen.add(filePath)
      changedFiles.push({
        path: filePath,
        status: "M",
        additions: parseInt(add, 10) || 0,
        deletions: parseInt(del, 10) || 0,
      })
    }
  }

  // Detect added/deleted files via --diff-filter
  try {
    const added = execFileSync(
      "git",
      ["diff", "--diff-filter=A", "--name-only", `${defaultBranch}..HEAD`],
      { cwd: wt.path, encoding: "utf-8" }
    ).trim().split("\n").filter(Boolean)
    const deleted = execFileSync(
      "git",
      ["diff", "--diff-filter=D", "--name-only", `${defaultBranch}..HEAD`],
      { cwd: wt.path, encoding: "utf-8" }
    ).trim().split("\n").filter(Boolean)
    for (const f of changedFiles) {
      if (added.includes(f.path)) f.status = "A"
      if (deleted.includes(f.path)) f.status = "D"
    }
  } catch { /* */ }
} catch { /* */ }
```

Then add `changedFiles` to the return object (after `createdAt`):

```typescript
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
  changedFiles,
}
```

**Step 5: Run tests**

Run: `bun run test -- server/__tests__/routes/worktrees.test.ts`
Expected: PASS

Run: `bun run test`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add server/helpers.ts server/routes/worktrees.ts server/__tests__/routes/worktrees.test.ts
git commit -m "feat(worktree): add changedFiles to worktree API response"
```

---

## Task 4: Redesign WorktreePanel with Sheet and file changes

**Files:**
- Modify: `src/components/WorktreePanel.tsx`

**Step 1: Rewrite WorktreePanel**

Replace the entire `WorktreePanel.tsx` contents. The component now:
- Wraps content in `Sheet` + `SheetContent`
- Uses `Collapsible` for per-worktree file changes accordion
- Accepts `open` and `onOpenChange` props (controlled by parent)
- Removes the `w-72 shrink-0 border-l` sidebar styling — Sheet handles layout
- Keeps all action handlers unchanged

```tsx
import { useState } from "react"
import {
  GitBranch,
  Trash2,
  GitPullRequest,
  ExternalLink,
  RefreshCw,
  Sparkles,
  ChevronRight,
  FileCode2,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { formatRelativeTime } from "@/lib/format"
import { authFetch } from "@/lib/auth"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible"
import type { WorktreeInfo } from "../../server/helpers"

interface WorktreePanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  worktrees: WorktreeInfo[]
  loading: boolean
  dirName: string | null
  onRefetch: () => void
  onOpenSession: (sessionId: string) => void
}

const statusColors: Record<string, string> = {
  M: "text-amber-400",
  A: "text-emerald-400",
  D: "text-red-400",
  R: "text-blue-400",
}

export function WorktreePanel({
  open,
  onOpenChange,
  worktrees,
  loading,
  dirName,
  onRefetch,
  onOpenSession,
}: WorktreePanelProps) {
  const [deleting, setDeleting] = useState<string | null>(null)
  const [creatingPr, setCreatingPr] = useState<string | null>(null)
  const [cleaningUp, setCleaningUp] = useState(false)

  // handleDelete, handleCreatePr, handleCleanup — keep exact same implementations
  // (copy from current WorktreePanel.tsx lines 35-110, unchanged)

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
    } catch (err) {
      alert(`Failed to delete worktree: ${err instanceof Error ? err.message : "Unknown error"}`)
    }
    setDeleting(null)
  }

  const handleCreatePr = async (wt: WorktreeInfo) => {
    if (!dirName) return
    setCreatingPr(wt.name)
    try {
      const res = await authFetch(`/api/worktrees/${encodeURIComponent(dirName)}/create-pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worktreeName: wt.name, title: wt.name.replace(/-/g, " ") }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.url) window.open(data.url, "_blank")
        else alert("PR created but no URL was returned")
      } else {
        const error = await res.json().catch(() => ({ error: "Unknown error" }))
        alert(`Failed to create PR: ${error.error || "Unknown error"}`)
      }
    } catch (err) {
      alert(`Error creating PR: ${err instanceof Error ? err.message : "Unknown error"}`)
    }
    setCreatingPr(null)
  }

  const handleCleanup = async () => {
    if (!dirName) return
    setCleaningUp(true)
    try {
      const listRes = await authFetch(`/api/worktrees/${encodeURIComponent(dirName)}/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      if (listRes.ok) {
        const { stale } = await listRes.json()
        if (stale.length === 0) {
          alert("No stale worktrees found.")
        } else if (confirm(`Remove ${stale.length} stale worktree(s)?\n\n${stale.map((s: { name: string }) => s.name).join("\n")}`)) {
          await authFetch(`/api/worktrees/${encodeURIComponent(dirName)}/cleanup`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirm: true, names: stale.map((s: { name: string }) => s.name) }),
          })
          onRefetch()
        }
      }
    } catch (err) {
      alert(`Cleanup failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    }
    setCleaningUp(false)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <div className="flex items-center justify-between pr-8">
            <SheetTitle className="flex items-center gap-2">
              <GitBranch className="size-4" />
              Worktrees
            </SheetTitle>
            <div className="flex items-center gap-1">
              <button
                onClick={handleCleanup}
                disabled={cleaningUp}
                className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-elevation-1 transition-colors"
                title="Cleanup stale worktrees"
              >
                <Sparkles className="size-3.5" />
              </button>
              <button
                onClick={onRefetch}
                disabled={loading}
                className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-elevation-1 transition-colors"
                title="Refresh"
              >
                <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              </button>
            </div>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {!dirName && (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              Select a project to view worktrees
            </div>
          )}

          {dirName && worktrees.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <GitBranch className="size-8 mb-2 opacity-40" />
              <p className="text-sm">No worktrees</p>
              <p className="text-xs mt-1 text-center px-4">
                Create a new session with &ldquo;Isolate in worktree&rdquo; enabled
              </p>
            </div>
          )}

          {worktrees.map((wt) => {
            const totalAdded = wt.changedFiles?.reduce((s, f) => s + f.additions, 0) ?? 0
            const totalDeleted = wt.changedFiles?.reduce((s, f) => s + f.deletions, 0) ?? 0
            const fileCount = wt.changedFiles?.length ?? 0

            return (
              <div
                key={wt.name}
                className="rounded-lg border border-border p-3 hover:bg-elevation-1/50 transition-colors"
              >
                {/* Header row */}
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium text-foreground truncate">{wt.name}</span>
                    {wt.isDirty && (
                      <span className="flex h-2 w-2 shrink-0 rounded-full bg-amber-400" title="Uncommitted changes" />
                    )}
                    {wt.commitsAhead > 0 && (
                      <Badge variant="outline" className="h-4 px-1 text-[9px] shrink-0">
                        {wt.commitsAhead} ahead
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
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

                {/* Commit info */}
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="font-mono shrink-0">{wt.head}</span>
                  <span className="truncate">{wt.headMessage}</span>
                </div>

                {wt.createdAt && (
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {formatRelativeTime(wt.createdAt)}
                  </div>
                )}

                {/* File changes accordion */}
                {fileCount > 0 && (
                  <Collapsible className="mt-2">
                    <CollapsibleTrigger className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors group w-full">
                      <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
                      <FileCode2 className="size-3" />
                      <span>
                        {fileCount} file{fileCount !== 1 ? "s" : ""} changed
                      </span>
                      <span className="ml-1">
                        <span className="text-emerald-400">+{totalAdded}</span>
                        {" "}
                        <span className="text-red-400">-{totalDeleted}</span>
                      </span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="mt-1.5 space-y-px rounded-md border border-border/50 bg-elevation-1/50 p-1.5">
                        {wt.changedFiles.map((f) => (
                          <div key={f.path} className="flex items-center gap-2 text-[10px] font-mono py-0.5 px-1">
                            <span className={cn("shrink-0 w-3 text-center", statusColors[f.status] || "text-muted-foreground")}>
                              {f.status}
                            </span>
                            <span className="truncate text-foreground/80">{f.path}</span>
                            <span className="ml-auto shrink-0 text-muted-foreground">
                              <span className="text-emerald-400/70">+{f.additions}</span>
                              {" "}
                              <span className="text-red-400/70">-{f.deletions}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </div>
            )
          })}
        </div>
      </SheetContent>
    </Sheet>
  )
}
```

**Step 2: Run build**

Run: `bun run build`
Expected: Build succeeds (component API changed but not yet wired)

**Step 3: Commit**

```bash
git add src/components/WorktreePanel.tsx
git commit -m "feat(worktree): redesign WorktreePanel as sheet with file changes"
```

---

## Task 5: Wire Sheet into App.tsx

**Files:**
- Modify: `src/App.tsx:892-905`

**Step 1: Update WorktreePanel usage**

In `src/App.tsx`, replace the current inline sidebar rendering (lines 892-905):

Replace:

```tsx
{showWorktrees && (
  <WorktreePanel
    worktrees={worktreeData.worktrees}
    loading={worktreeData.loading}
    dirName={currentDirName}
    onRefetch={worktreeData.refetch}
    onOpenSession={(sessionId) => {
      if (currentDirName) {
        actions.handleDashboardSelect(currentDirName, `${sessionId}.jsonl`)
      }
    }}
  />
)}
```

With:

```tsx
<WorktreePanel
  open={showWorktrees}
  onOpenChange={setShowWorktrees}
  worktrees={worktreeData.worktrees}
  loading={worktreeData.loading}
  dirName={currentDirName}
  onRefetch={worktreeData.refetch}
  onOpenSession={(sessionId) => {
    if (currentDirName) {
      actions.handleDashboardSelect(currentDirName, `${sessionId}.jsonl`)
    }
    setShowWorktrees(false)
  }}
/>
```

Note the changes:
1. Removed the `{showWorktrees && ...}` conditional — Sheet handles visibility via `open` prop
2. Added `open` and `onOpenChange` props
3. Added `setShowWorktrees(false)` after opening a session (auto-close sheet)
4. Moved the component **after** the flex layout `</div>` (after line 906) so it renders as a portal overlay, not inside the flex container

**Step 2: Run tests**

Run: `bun run test`
Expected: ALL PASS

**Step 3: Run build**

Run: `bun run build`
Expected: Build succeeds with no type errors

**Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat(worktree): wire sheet-based WorktreePanel into App"
```

---

## Task 6: Final verification

**Step 1: Run full test suite**

Run: `bun run test`
Expected: ALL PASS

**Step 2: Run build**

Run: `bun run build`
Expected: Build succeeds

**Step 3: Commit any fixes**

Only if needed:

```bash
git add -u
git commit -m "fix(worktree): address v2 integration issues"
```

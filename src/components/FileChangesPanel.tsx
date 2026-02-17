import { useMemo, useState, useRef, useCallback, useEffect } from "react"
import { FileCode2, CheckCircle, XCircle, ChevronDown, ChevronRight, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { EditDiffView } from "./timeline/EditDiffView"
import { getToolBadgeStyle } from "./timeline/ToolCallCard"
import type { ParsedSession, ToolCall } from "@/lib/types"
import { cn } from "@/lib/utils"

// Cache: sessionId -> { pathsHash, deletedFiles }
const deletedFilesCache = new Map<string, { pathsHash: string; deleted: Map<string, number> }>()

interface FileChange {
  turnIndex: number
  toolCall: ToolCall
}

interface FileChangesPanelProps {
  session: ParsedSession
  sessionChangeKey: number
}

/** Count actually changed lines via LCS diff (matches EditDiffView logic exactly) */
function diffLineCount(oldStr: string, newStr: string): { add: number; del: number } {
  if (!oldStr && !newStr) return { add: 0, del: 0 }
  const oldLines = oldStr ? oldStr.split("\n") : []
  const newLines = newStr ? newStr.split("\n") : []
  if (oldLines.length === 0) return { add: newLines.length, del: 0 }
  if (newLines.length === 0) return { add: 0, del: oldLines.length }

  const m = oldLines.length
  const n = newLines.length

  // Trim common prefix/suffix to shrink LCS matrix
  let prefix = 0
  while (prefix < m && prefix < n && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (
    suffix < m - prefix &&
    suffix < n - prefix &&
    oldLines[m - 1 - suffix] === newLines[n - 1 - suffix]
  ) suffix++

  const om = m - prefix - suffix
  const on = n - prefix - suffix
  if (om === 0) return { add: on, del: 0 }
  if (on === 0) return { add: 0, del: om }

  // LCS on the trimmed middle only
  const dp: number[][] = Array.from({ length: om + 1 }, () => Array(on + 1).fill(0))
  for (let i = 1; i <= om; i++) {
    for (let j = 1; j <= on; j++) {
      dp[i][j] =
        oldLines[prefix + i - 1] === newLines[prefix + j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  // Count added/removed by backtracking
  let add = 0
  let del = 0
  let i = om
  let j = on
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[prefix + i - 1] === newLines[prefix + j - 1]) {
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      add++; j--
    } else {
      del++; i--
    }
  }

  return { add, del }
}

function FileChangeCard({ turnIndex, toolCall }: FileChange) {
  const [open, setOpen] = useState(true)

  const filePath = String(toolCall.input.file_path ?? toolCall.input.path ?? "")
  const shortPath = filePath.split("/").slice(-3).join("/")
  const isEdit = toolCall.name === "Edit"
  const oldString = isEdit ? String(toolCall.input.old_string ?? "") : ""
  const newString = isEdit
    ? String(toolCall.input.new_string ?? "")
    : String(toolCall.input.content ?? "")

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/30 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-2.5 py-1.5 hover:bg-zinc-800/50 transition-colors"
      >
        {open ? (
          <ChevronDown className="size-3 text-zinc-500 shrink-0" />
        ) : (
          <ChevronRight className="size-3 text-zinc-500 shrink-0" />
        )}
        <Badge
          variant="outline"
          className={cn(
            "text-[10px] px-1.5 py-0 h-4 font-mono shrink-0",
            getToolBadgeStyle(toolCall.name)
          )}
        >
          {toolCall.name}
        </Badge>
        <span className="text-[10px] text-zinc-400 font-mono truncate">
          {shortPath}
        </span>
        <span className="text-[10px] text-zinc-600 shrink-0">
          T{turnIndex + 1}
        </span>
        <div className="flex-1" />
        {toolCall.isError ? (
          <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
        ) : toolCall.result !== null ? (
          <CheckCircle className="w-3.5 h-3.5 text-green-500/60 shrink-0" />
        ) : null}
      </button>
      {open && (
        <EditDiffView
          oldString={oldString}
          newString={newString}
          filePath={filePath}
          compact={false}
        />
      )}
    </div>
  )
}

function DeletedFileCard({ filePath, lineCount, turnIndex }: { filePath: string; lineCount: number; turnIndex: number }) {
  const shortPath = filePath.split("/").slice(-3).join("/")
  return (
    <div className="rounded-md border border-red-900/40 bg-red-950/20 overflow-hidden">
      <div className="flex items-center gap-2 w-full px-2.5 py-1.5">
        <Trash2 className="size-3 text-red-400/70 shrink-0" />
        <Badge
          variant="outline"
          className="text-[10px] px-1.5 py-0 h-4 font-mono shrink-0 border-red-800/60 text-red-400"
        >
          Deleted
        </Badge>
        <span className="text-[10px] text-zinc-500 font-mono truncate">
          {shortPath}
        </span>
        <span className="text-[10px] text-zinc-600 shrink-0">
          T{turnIndex + 1}
        </span>
        <div className="flex-1" />
        {lineCount > 0 && (
          <span className="text-[10px] font-mono tabular-nums text-red-400/70 shrink-0">
            -{lineCount}
          </span>
        )}
      </div>
    </div>
  )
}

export function FileChangesPanel({ session, sessionChangeKey }: FileChangesPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const scrollOnNextChangeRef = useRef(false)
  const prevChangeCountRef = useRef(0)
  const prevTurnCountRef = useRef(session.turns.length)
  const [canScrollUp, setCanScrollUp] = useState(false)
  const [canScrollDown, setCanScrollDown] = useState(false)

  const { fileChanges, additions, deletions } = useMemo(() => {
    const changes: FileChange[] = []
    let add = 0
    let del = 0
    session.turns.forEach((turn, turnIndex) => {
      turn.toolCalls.forEach((tc) => {
        if (tc.name === "Edit" || tc.name === "Write") {
          changes.push({ turnIndex, toolCall: tc })
          const isEdit = tc.name === "Edit"
          const oldStr = isEdit ? String(tc.input.old_string ?? "") : ""
          const newStr = isEdit
            ? String(tc.input.new_string ?? "")
            : String(tc.input.content ?? "")
          const d = diffLineCount(oldStr, newStr)
          add += d.add
          del += d.del
        }
      })
    })
    return { fileChanges: changes, additions: add, deletions: del }
  }, [session])

  // Extract absolute paths from rm/git rm Bash commands
  const rmPaths = useMemo(() => {
    const paths: { path: string; isDir: boolean; turnIndex: number }[] = []
    session.turns.forEach((turn, turnIndex) => {
      turn.toolCalls.forEach((tc) => {
        if (tc.name !== "Bash") return
        const cmd = String(tc.input.command ?? "")
        if (!cmd) return
        // Match rm or git rm commands (possibly with flags)
        const rmMatch = cmd.match(/^(?:rm|git\s+rm)\s/)
        if (!rmMatch) return
        const isDir = /\s-[a-zA-Z]*r/.test(cmd) // -r, -rf, -Rf etc.
        // Extract quoted absolute paths
        const quoted = cmd.matchAll(/"(\/[^"]+)"/g)
        for (const m of quoted) {
          paths.push({ path: m[1], isDir, turnIndex })
        }
        // Extract unquoted absolute paths (space-separated, no special chars)
        const parts = cmd.replace(/"[^"]*"/g, "").split(/\s+/)
        for (const part of parts) {
          if (part.startsWith("/") && !part.startsWith("//")) {
            // Strip trailing redirects like 2>/dev/null
            const clean = part.replace(/\s*[12]?>.*$/, "")
            if (clean) paths.push({ path: clean, isDir, turnIndex })
          }
        }
      })
    })
    return paths
  }, [session])

  // Collect ALL file paths from any tool call + rm commands
  const { uniquePaths, rmDirs, pathsHash } = useMemo(() => {
    const paths = new Set<string>()
    const dirs: string[] = []
    session.turns.forEach((turn) => {
      turn.toolCalls.forEach((tc) => {
        const p = String(tc.input.file_path ?? tc.input.path ?? "")
        if (p && p.startsWith("/")) paths.add(p)
      })
    })
    for (const rp of rmPaths) {
      if (rp.isDir) {
        dirs.push(rp.path)
      } else {
        paths.add(rp.path)
      }
    }
    const sorted = [...paths].sort()
    const hash = sorted.join("\0") + "\n" + dirs.sort().join("\0")
    return { uniquePaths: sorted, rmDirs: dirs, pathsHash: hash }
  }, [session, rmPaths])

  // For each file path, find the last turn index that references it
  const lastTurnForFile = useMemo(() => {
    const map = new Map<string, number>()
    session.turns.forEach((turn, turnIndex) => {
      turn.toolCalls.forEach((tc) => {
        const p = String(tc.input.file_path ?? tc.input.path ?? "")
        if (p && p.startsWith("/")) map.set(p, turnIndex)
      })
    })
    // Also add rm command turn indices
    for (const rp of rmPaths) {
      const existing = map.get(rp.path)
      if (existing === undefined || rp.turnIndex > existing) {
        map.set(rp.path, rp.turnIndex)
      }
    }
    return map
  }, [session, rmPaths])

  // deleted files: Map<path, lineCount> (line count from git via server)
  const [deletedFilesMap, setDeletedFilesMap] = useState<Map<string, number>>(new Map())

  // Keep refs so the effect can read the latest without re-firing
  const uniquePathsRef = useRef(uniquePaths)
  uniquePathsRef.current = uniquePaths
  const rmDirsRef = useRef(rmDirs)
  rmDirsRef.current = rmDirs

  // Check which files have been deleted, with caching
  useEffect(() => {
    const paths = uniquePathsRef.current
    const dirs = rmDirsRef.current
    if (paths.length === 0 && dirs.length === 0) {
      setDeletedFilesMap(new Map())
      return
    }

    const sessionId = session.sessionId
    const cached = deletedFilesCache.get(sessionId)
    if (cached && cached.pathsHash === pathsHash) {
      setDeletedFilesMap(cached.deleted)
      return
    }

    let cancelled = false
    fetch("/api/check-files-exist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: paths, dirs }),
    })
      .then((r) => r.json())
      .then((data: { deleted: { path: string; lines: number }[] }) => {
        if (cancelled) return
        const map = new Map(data.deleted.map((d) => [d.path, d.lines]))
        deletedFilesCache.set(sessionId, { pathsHash, deleted: map })
        setDeletedFilesMap(map)
      })
      .catch(() => {})

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsHash, session.sessionId])

  // Build unified ordered list: file changes + deleted file entries, sorted by turn index
  const renderItems = useMemo(() => {
    type RenderItem =
      | { type: "change"; turnIndex: number; toolCall: ToolCall; key: string }
      | { type: "deleted"; turnIndex: number; filePath: string; lines: number; key: string }

    const items: RenderItem[] = []

    // Add all Edit/Write cards
    for (const fc of fileChanges) {
      items.push({ type: "change", turnIndex: fc.turnIndex, toolCall: fc.toolCall, key: fc.toolCall.id })
    }

    // Add deleted file cards (skip files already in Edit/Write list — they'll show as regular cards)
    const editWritePaths = new Set(fileChanges.map((fc) => String(fc.toolCall.input.file_path ?? fc.toolCall.input.path ?? "")))
    for (const [fp, lines] of deletedFilesMap) {
      if (editWritePaths.has(fp)) continue
      // Try direct lookup first, then check if file falls under an rm -rf directory
      let turnIndex = lastTurnForFile.get(fp)
      if (turnIndex === undefined) {
        for (const rp of rmPaths) {
          if (rp.isDir && fp.startsWith(rp.path + "/")) {
            turnIndex = rp.turnIndex
            break
          }
        }
      }
      items.push({ type: "deleted", turnIndex: turnIndex ?? 0, filePath: fp, lines, key: `deleted-${fp}` })
    }

    // Stable sort by turnIndex (preserves insertion order within same turn)
    items.sort((a, b) => a.turnIndex - b.turnIndex)
    return items
  }, [fileChanges, deletedFilesMap, lastTurnForFile, rmPaths])

  // Adjust totals: subtract Edit/Write contributions for files that ended up deleted
  const { totalAdditions, totalDeletions } = useMemo(() => {
    let adjAdd = additions
    let adjDel = deletions

    // Remove Edit/Write line counts for files that no longer exist
    for (const fc of fileChanges) {
      const p = String(fc.toolCall.input.file_path ?? fc.toolCall.input.path ?? "")
      if (!deletedFilesMap.has(p)) continue
      const isEdit = fc.toolCall.name === "Edit"
      const oldStr = isEdit ? String(fc.toolCall.input.old_string ?? "") : ""
      const newStr = isEdit
        ? String(fc.toolCall.input.new_string ?? "")
        : String(fc.toolCall.input.content ?? "")
      const d = diffLineCount(oldStr, newStr)
      adjAdd -= d.add
      adjDel -= d.del
    }

    // Add git-based line counts for all deleted files
    let gitDel = 0
    for (const [, lines] of deletedFilesMap) {
      gitDel += lines
    }

    return {
      totalAdditions: Math.max(0, adjAdd),
      totalDeletions: Math.max(0, adjDel) + gitDel,
    }
  }, [additions, deletions, fileChanges, deletedFilesMap])

  const updateScrollIndicators = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollUp(el.scrollTop > 10)
    setCanScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 10)
  }, [])

  // Track whether user is scrolled to the bottom + update indicators
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    isAtBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 50
    updateScrollIndicators()
  }, [updateScrollIndicators])

  // Update indicators when content changes
  useEffect(() => {
    updateScrollIndicators()
  }, [fileChanges.length, updateScrollIndicators])

  // Reset scroll position instantly when switching sessions
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    isAtBottomRef.current = true
    scrollOnNextChangeRef.current = false
    prevChangeCountRef.current = fileChanges.length
    prevTurnCountRef.current = session.turns.length
    updateScrollIndicators()
  }, [sessionChangeKey])

  // Detect new turns (user sent a new prompt)
  useEffect(() => {
    const turnCount = session.turns.length
    if (turnCount > prevTurnCountRef.current) {
      scrollOnNextChangeRef.current = true
    }
    prevTurnCountRef.current = turnCount
  }, [session.turns.length])

  // Auto-scroll when new file changes arrive
  useEffect(() => {
    if (fileChanges.length <= prevChangeCountRef.current) {
      prevChangeCountRef.current = fileChanges.length
      return
    }
    prevChangeCountRef.current = fileChanges.length

    if (scrollOnNextChangeRef.current || isAtBottomRef.current) {
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" })
      })
      scrollOnNextChangeRef.current = false
    }
  }, [fileChanges.length])

  if (fileChanges.length === 0) return null

  return (
    <div className="flex flex-col h-full overflow-hidden border-zinc-800 min-w-0">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/50">
        <FileCode2 className="size-3.5 text-amber-400" />
        <span className="text-xs font-medium text-zinc-300">
          File Changes
        </span>
        <Badge
          variant="outline"
          className="h-4 px-1.5 text-[10px] border-zinc-700 text-zinc-500"
        >
          {fileChanges.length}
        </Badge>
        <div className="flex-1" />
        <span className="text-[10px] font-mono tabular-nums text-green-500/70">
          +{totalAdditions}
        </span>
        <span className="text-[10px] font-mono tabular-nums text-red-400/70">
          -{totalDeletions}
        </span>
      </div>
      <div className="relative flex-1 min-h-0">
        {/* Top fade */}
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-zinc-950 to-transparent transition-opacity duration-200",
            canScrollUp ? "opacity-100" : "opacity-0"
          )}
        />
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto"
        >
          <div className="p-3 space-y-3">
            {renderItems.map((item) =>
              item.type === "change" ? (
                <FileChangeCard
                  key={item.key}
                  turnIndex={item.turnIndex}
                  toolCall={item.toolCall}
                />
              ) : (
                <DeletedFileCard
                  key={item.key}
                  filePath={item.filePath}
                  lineCount={item.lines}
                  turnIndex={item.turnIndex}
                />
              )
            )}
          </div>
          <div ref={bottomRef} />
        </div>
        {/* Bottom fade */}
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-zinc-950 to-transparent transition-opacity duration-200",
            canScrollDown ? "opacity-100" : "opacity-0"
          )}
        />
      </div>
    </div>
  )
}

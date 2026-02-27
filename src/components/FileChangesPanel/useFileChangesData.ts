import { useMemo, useState, useRef, useEffect } from "react"
import type { ParsedSession, ToolCall } from "@/lib/types"
import { diffLineCount } from "@/lib/diffUtils"
import { authFetch } from "@/lib/auth"

// Cache: sessionId -> { pathsHash, deletedFiles }
const deletedFilesCache = new Map<string, { pathsHash: string; deleted: Map<string, number> }>()

export interface FileChange {
  turnIndex: number
  toolCall: ToolCall
  agentId?: string
}

export type RenderItem =
  | { type: "change"; turnIndex: number; toolCall: ToolCall; agentId?: string; key: string }
  | { type: "deleted"; turnIndex: number; filePath: string; lines: number; key: string }

export function useFileChangesData(session: ParsedSession) {
  // Stable cache key: total tool call count across all turns (cheaper than session object identity)
  const totalToolCallCount = useMemo(() => {
    let count = 0
    for (const turn of session.turns) {
      count += turn.toolCalls.length
      for (const msg of turn.subAgentActivity) count += msg.toolCalls.length
    }
    return count
  }, [session.turns.length, session.turns.at(-1)?.toolCalls.length])

  const { fileChanges, additions, deletions } = useMemo(() => {
    const changes: FileChange[] = []
    let add = 0
    let del = 0
    const collectToolCall = (tc: ToolCall, turnIndex: number, agentId?: string) => {
      if (tc.name !== "Edit" && tc.name !== "Write") return
      changes.push({ turnIndex, toolCall: tc, agentId })
      const isEdit = tc.name === "Edit"
      const oldStr = isEdit ? String(tc.input.old_string ?? "") : ""
      const newStr = isEdit
        ? String(tc.input.new_string ?? "")
        : String(tc.input.content ?? "")
      const d = diffLineCount(oldStr, newStr)
      add += d.add
      del += d.del
    }
    session.turns.forEach((turn, turnIndex) => {
      turn.toolCalls.forEach((tc) => collectToolCall(tc, turnIndex))
      turn.subAgentActivity.forEach((msg) => {
        msg.toolCalls.forEach((tc) => collectToolCall(tc, turnIndex, msg.agentId))
      })
    })
    return { fileChanges: changes, additions: add, deletions: del }
  }, [totalToolCallCount, session.turns])

  // Extract absolute paths from rm/git rm Bash commands
  const rmPaths = useMemo(() => {
    const paths: { path: string; isDir: boolean; turnIndex: number }[] = []
    const collectBashRm = (tc: ToolCall, turnIndex: number) => {
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
    }
    session.turns.forEach((turn, turnIndex) => {
      turn.toolCalls.forEach((tc) => collectBashRm(tc, turnIndex))
      turn.subAgentActivity.forEach((msg) => {
        msg.toolCalls.forEach((tc) => collectBashRm(tc, turnIndex))
      })
    })
    return paths
  }, [totalToolCallCount, session.turns])

  // Collect ALL file paths from any tool call + rm commands
  const { uniquePaths, rmDirs, pathsHash } = useMemo(() => {
    const paths = new Set<string>()
    const dirs: string[] = []
    const collectPath = (tc: ToolCall) => {
      const p = String(tc.input.file_path ?? tc.input.path ?? "")
      if (p && p.startsWith("/")) paths.add(p)
    }
    session.turns.forEach((turn) => {
      turn.toolCalls.forEach(collectPath)
      turn.subAgentActivity.forEach((msg) => msg.toolCalls.forEach(collectPath))
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
    const trackPath = (tc: ToolCall, turnIndex: number) => {
      const p = String(tc.input.file_path ?? tc.input.path ?? "")
      if (p && p.startsWith("/")) map.set(p, turnIndex)
    }
    session.turns.forEach((turn, turnIndex) => {
      turn.toolCalls.forEach((tc) => trackPath(tc, turnIndex))
      turn.subAgentActivity.forEach((msg) => {
        msg.toolCalls.forEach((tc) => trackPath(tc, turnIndex))
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
    authFetch("/api/check-files-exist", {
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
  }, [pathsHash, session.sessionId])

  // Build unified ordered list: file changes + deleted file entries, sorted by turn index
  const renderItems = useMemo(() => {
    const items: RenderItem[] = []

    // Add all Edit/Write cards
    for (const fc of fileChanges) {
      items.push({ type: "change", turnIndex: fc.turnIndex, toolCall: fc.toolCall, agentId: fc.agentId, key: fc.toolCall.id })
    }

    // Add deleted file cards (skip files already in Edit/Write list -- they'll show as regular cards)
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

  return {
    fileChanges,
    renderItems,
    totalAdditions,
    totalDeletions,
  }
}

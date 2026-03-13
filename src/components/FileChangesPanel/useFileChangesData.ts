import { useMemo, useState, useEffect, useRef } from "react"
import type { ParsedSession, ToolCall } from "@/lib/types"
import { computeNetDiff, type EditOp } from "@/lib/diffUtils"
import { authFetch } from "@/lib/auth"
import { useSessionContext } from "@/contexts/SessionContext"
import { parseSubagentJsonl } from "@/hooks/useSubagentContent"

interface FileChange {
  turnIndex: number
  toolCall: ToolCall
  agentId?: string
}

// Module-level cache for background agent file changes
const bgAgentCache = new Map<string, ToolCall[]>()

export function useFileChangesData(session: ParsedSession) {
  const { sessionSource } = useSessionContext()
  const dirName = sessionSource?.dirName

  // Stable cache key: total tool call count across all turns (cheaper than session object identity)
  const turnCount = session.turns.length
  const lastTurnToolCallCount = session.turns.at(-1)?.toolCalls.length ?? 0
  const totalToolCallCount = useMemo(() => {
    let count = 0
    for (const turn of session.turns) {
      count += turn.toolCalls.length
      for (const msg of turn.subAgentActivity) count += msg.toolCalls.length
    }
    return count
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cheap proxy deps to avoid full array comparison
  }, [turnCount, lastTurnToolCallCount])

  // Identify background agents that need their JSONL fetched for file changes
  const bgAgentsToLoad = useMemo(() => {
    const agents: Array<{ agentId: string; turnIndex: number }> = []
    for (let turnIndex = 0; turnIndex < session.turns.length; turnIndex++) {
      for (const msg of session.turns[turnIndex].subAgentActivity) {
        if (msg.isBackground && msg.toolCalls.length === 0) {
          agents.push({ agentId: msg.agentId, turnIndex })
        }
      }
    }
    return agents
  }, [session.turns, totalToolCallCount]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch background agent JSONL files to extract their tool calls
  const [bgToolCalls, setBgToolCalls] = useState<Map<string, ToolCall[]>>(new Map())
  const fetchedBgRef = useRef(new Set<string>())

  useEffect(() => {
    if (!dirName || !session.sessionId || bgAgentsToLoad.length === 0) return

    const toFetch: Array<{ agentId: string; cacheKey: string }> = []
    for (const { agentId } of bgAgentsToLoad) {
      const cacheKey = `${dirName}/${session.sessionId}/${agentId}`
      if (fetchedBgRef.current.has(cacheKey)) continue
      if (bgAgentCache.has(cacheKey)) {
        setBgToolCalls((prev) => {
          const next = new Map(prev)
          next.set(agentId, bgAgentCache.get(cacheKey)!)
          return next
        })
        fetchedBgRef.current.add(cacheKey)
        continue
      }
      toFetch.push({ agentId, cacheKey })
    }

    if (toFetch.length === 0) return

    let cancelled = false

    async function fetchAll() {
      const results = new Map<string, ToolCall[]>()
      await Promise.all(
        toFetch.map(async ({ agentId, cacheKey }) => {
          try {
            const url = `/api/sessions/${encodeURIComponent(dirName!)}/${encodeURIComponent(session.sessionId)}` +
              `/subagents/agent-${encodeURIComponent(agentId)}.jsonl`
            const res = await authFetch(url)
            if (!res.ok) return
            const text = await res.text()
            const parsed = parseSubagentJsonl(text, agentId)
            const tcs: ToolCall[] = []
            for (const msg of parsed) {
              for (const tc of msg.toolCalls) {
                if ((tc.name === "Edit" || tc.name === "Write") && !tc.isError) tcs.push(tc)
              }
            }
            bgAgentCache.set(cacheKey, tcs)
            fetchedBgRef.current.add(cacheKey)
            results.set(agentId, tcs)
          } catch { /* skip */ }
        })
      )
      if (!cancelled && results.size > 0) {
        setBgToolCalls((prev) => {
          const next = new Map(prev)
          for (const [id, tcs] of results) next.set(id, tcs)
          return next
        })
      }
    }

    fetchAll()
    return () => { cancelled = true }
  }, [dirName, session.sessionId, bgAgentsToLoad])

  const fileChanges = useMemo(() => {
    const changes: FileChange[] = []
    const processedBgAgents = new Set<string>()
    for (let turnIndex = 0; turnIndex < session.turns.length; turnIndex++) {
      const turn = session.turns[turnIndex]
      for (const tc of turn.toolCalls) {
        if ((tc.name === "Edit" || tc.name === "Write") && !tc.isError) {
          changes.push({ turnIndex, toolCall: tc })
        }
      }
      for (const msg of turn.subAgentActivity) {
        // For foreground sub-agents with inline tool calls
        for (const tc of msg.toolCalls) {
          if ((tc.name === "Edit" || tc.name === "Write") && !tc.isError) {
            changes.push({ turnIndex, toolCall: tc, agentId: msg.agentId })
          }
        }
        // For background agents: use fetched tool calls from their JSONL files
        // Only process each background agent once to avoid duplication across turns
        if (msg.isBackground && msg.toolCalls.length === 0 && !processedBgAgents.has(msg.agentId)) {
          processedBgAgents.add(msg.agentId)
          const fetched = bgToolCalls.get(msg.agentId)
          if (fetched) {
            for (const tc of fetched) {
              changes.push({ turnIndex, toolCall: tc, agentId: msg.agentId })
            }
          }
        }
      }
    }
    return changes
    // eslint-disable-next-line react-hooks/exhaustive-deps -- totalToolCallCount is an intentional cache-busting key
  }, [totalToolCallCount, session.turns, bgToolCalls])

  // Fetch actual file contents from disk for line number resolution
  const filePaths = useMemo(() => {
    const paths = new Set<string>()
    for (const fc of fileChanges) {
      const fp = getToolCallFilePath(fc.toolCall)
      if (fp) paths.add(fp)
    }
    return [...paths]
  }, [fileChanges])

  const [fileContents, setFileContents] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    if (filePaths.length === 0) return
    let cancelled = false
    Promise.all(
      filePaths.map((p) =>
        authFetch(`/api/file-content?path=${encodeURIComponent(p)}`)
          .then((r) => (r.ok ? r.text() : null))
          .then((text) => (text ? ([p, text] as const) : null))
          .catch(() => null),
      ),
    ).then((results) => {
      if (cancelled) return
      const map = new Map<string, string>()
      for (const r of results) {
        if (r) map.set(r[0], r[1])
      }
      setFileContents(map)
    })
    return () => { cancelled = true }
  }, [filePaths])

  // ── Grouped-by-file view with net diffs ─────────────────────────────────

  const lastTurnIndex = session.turns.length - 1

  /** Group file changes by file path, compute net diff per file. */
  const groupedByFile = useMemo(() => {
    return buildGroupedFiles(fileChanges, "all", fileContents)
  }, [fileChanges, fileContents])

  /** Same but filtered to only the last turn. */
  const groupedLastTurn = useMemo(() => {
    return buildGroupedFiles(fileChanges, lastTurnIndex, fileContents)
  }, [fileChanges, lastTurnIndex, fileContents])

  // Build agent metadata map (agentId → { name, type })
  const agentMap = useMemo(() => {
    const map = new Map<string, { name: string | null; type: string | null }>()
    for (const turn of session.turns) {
      for (const msg of turn.subAgentActivity) {
        if (!map.has(msg.agentId)) {
          map.set(msg.agentId, { name: msg.agentName, type: msg.subagentType })
        }
      }
    }
    return map
  }, [session.turns])

  return {
    fileChanges,
    fileContents,
    groupedByFile,
    groupedLastTurn,
    lastTurnIndex,
    agentMap,
  }
}

// ── Grouped file types & builder ──────────────────────────────────────────

/** A single edit/write operation with its before/after strings. */
export interface IndividualEdit {
  oldString: string
  newString: string
  toolName: "Edit" | "Write"
  turnIndex: number
  agentId?: string
  /** 1-based starting line number in the file (parsed from Edit tool result). */
  startLine: number
}

export interface GroupedFile {
  filePath: string
  /** Short display path (last 3 segments). */
  shortPath: string
  editCount: number
  turnRange: [number, number]
  /** Which tool types were used: "Edit", "Write", or both. */
  opTypes: ("Edit" | "Write")[]
  /** Reconstructed content before edits (for diffing). */
  netOriginal: string
  /** Reconstructed content after edits (for diffing). */
  netCurrent: string
  addCount: number
  delCount: number
  /** Last sub-agent ID that modified this file (for navigation). */
  subAgentId: string | null
  /** Individual edits in order, for per-edit diff view. */
  edits: IndividualEdit[]
/** 1-based starting line for the net diff (from first edit's result). */
  netStartLine: number
}

/**
 * Find the 1-based line number of `searchStr` in raw file content.
 * Returns 1 if not found.
 */
function findLineInFile(fileContent: string | undefined, searchStr: string): number {
  if (!fileContent || !searchStr) return 1
  const idx = fileContent.indexOf(searchStr)
  if (idx === -1) return 1
  // Count newlines before the match to get the 1-based line number
  let line = 1
  for (let i = 0; i < idx; i++) {
    if (fileContent[i] === "\n") line++
  }
  return line
}

/** Extract the file path from an Edit or Write tool call. */
function getToolCallFilePath(tc: ToolCall): string {
  return String(tc.input.file_path ?? tc.input.path ?? "")
}

/** Convert a tool call into an EditOp for net diff computation. */
function toEditOp(tc: ToolCall): EditOp {
  const isEdit = tc.name === "Edit"
  return {
    oldString: isEdit ? String(tc.input.old_string ?? "") : "",
    newString: isEdit
      ? String(tc.input.new_string ?? "")
      : String(tc.input.content ?? ""),
    isWrite: !isEdit,
  }
}

export function buildGroupedFiles(
  changes: FileChange[],
  scope: "all" | number,
  fileContents?: Map<string, string>,
): GroupedFile[] {
  const byFile = new Map<string, FileChange[]>()
  for (const fc of changes) {
    if (scope !== "all" && fc.turnIndex !== scope) continue
    const fp = getToolCallFilePath(fc.toolCall)
    if (!fp) continue
    let arr = byFile.get(fp)
    if (!arr) {
      arr = []
      byFile.set(fp, arr)
    }
    arr.push(fc)
  }

  const result: GroupedFile[] = []
  for (const [filePath, fcs] of byFile) {
    // Single pass: build ops, edits, min/max turn, opTypes, last subAgentId
    const ops: EditOp[] = []
    const edits: IndividualEdit[] = []
    let minTurn = Infinity
    let maxTurn = -Infinity
    let hasEdit = false
    let hasWrite = false
    let lastSubAgentId: string | undefined

    const rawContent = fileContents?.get(filePath)
    for (let i = 0; i < fcs.length; i++) {
      const fc = fcs[i]
      const op = toEditOp(fc.toolCall)
      ops.push(op)

      if (fc.turnIndex < minTurn) minTurn = fc.turnIndex
      if (fc.turnIndex > maxTurn) maxTurn = fc.turnIndex
      if (fc.toolCall.name === "Edit") hasEdit = true
      else hasWrite = true
      if (fc.agentId) lastSubAgentId = fc.agentId

      edits.push({
        oldString: op.oldString,
        newString: op.newString,
        toolName: fc.toolCall.name as "Edit" | "Write",
        turnIndex: fc.turnIndex,
        agentId: fc.agentId,
        startLine: fc.toolCall.name === "Write" ? 1 : findLineInFile(rawContent, op.newString || op.oldString),
      })
    }

    const net = computeNetDiff(ops)
    const opTypes: ("Edit" | "Write")[] = []
    if (hasEdit) opTypes.push("Edit")
    if (hasWrite) opTypes.push("Write")

    result.push({
      filePath,
      shortPath: filePath.split("/").slice(-3).join("/"),
      editCount: fcs.length,
      turnRange: [minTurn, maxTurn],
      opTypes,
      netOriginal: net.originalStr,
      netCurrent: net.currentStr,
      addCount: net.addCount,
      delCount: net.delCount,
      subAgentId: lastSubAgentId ?? null,
      edits,
      netStartLine: net.currentStr
        ? findLineInFile(rawContent, net.currentStr)
        : (edits.length > 0 ? edits[0].startLine : 1),
    })
  }

  result.sort((a, b) => a.turnRange[1] - b.turnRange[1] || a.turnRange[0] - b.turnRange[0] || a.filePath.localeCompare(b.filePath))
  return result
}

// ── Agent-grouped view ────────────────────────────────────────────────────

export interface AgentGroup {
  agentId: string
  agentName: string | null
  subagentType: string | null
  files: GroupedFile[]
  totalAdd: number
  totalDel: number
}

/**
 * Group file changes by subagent, then by file within each agent.
 * Only includes changes with an agentId (excludes main agent).
 * If a file was changed by two agents, it appears under each.
 */
export function buildGroupedFilesByAgent(
  changes: FileChange[],
  scope: "all" | number,
  agentMap: Map<string, { name: string | null; type: string | null }>,
  fileContents?: Map<string, string>,
): AgentGroup[] {
  // First, bucket changes by agentId (skip main-agent changes)
  const byAgent = new Map<string, FileChange[]>()
  for (const fc of changes) {
    if (!fc.agentId) continue
    if (scope !== "all" && fc.turnIndex !== scope) continue
    let arr = byAgent.get(fc.agentId)
    if (!arr) {
      arr = []
      byAgent.set(fc.agentId, arr)
    }
    arr.push(fc)
  }

  const groups: AgentGroup[] = []
  for (const [agentId, agentChanges] of byAgent) {
    // Reuse buildGroupedFiles with a filtered change list (all turns within the agent)
    const files = buildGroupedFiles(agentChanges, "all", fileContents)
    if (files.length === 0) continue

    let totalAdd = 0
    let totalDel = 0
    for (const f of files) {
      totalAdd += f.addCount
      totalDel += f.delCount
    }

    const meta = agentMap.get(agentId)
    groups.push({
      agentId,
      agentName: meta?.name ?? null,
      subagentType: meta?.type ?? null,
      files,
      totalAdd,
      totalDel,
    })
  }

  // Sort by first file's turn range (earliest activity first)
  groups.sort((a, b) => {
    const aMin = a.files[0]?.turnRange[0] ?? 0
    const bMin = b.files[0]?.turnRange[0] ?? 0
    return aMin - bMin
  })

  return groups
}

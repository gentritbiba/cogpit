import { useMemo, useState, useEffect, useRef } from "react"
import type { ToolCall } from "../../../shared/session/types"
import type { SessionView } from "../../../shared/session/sessionDigest"
import { computeNetDiff, type EditOp } from "../../../shared/diff-utils"
import { expandEditToolCalls } from "../../../shared/session/edit-calls"
import { authFetch } from "@/lib/auth"
import { useSessionControls } from "@/contexts/SessionContext"
import { parseSubagentJsonl } from "@/hooks/useSubagentContent"
import { agentKindForDirName } from "@/lib/agents"
import { useCapability } from "@/hooks/useCapability"
import { deviceScopedKey } from "@/lib/device"

interface FileChange {
  turnIndex: number
  toolCall: ToolCall
  agentId?: string
}

// Background agents' tool calls by agent, with the revision of its transcript they were read at.
const bgAgentCache = new Map<string, { revision: string; toolCalls: ToolCall[] }>()
const bgAgentLoads = new Map<string, Promise<void>>()
const bgAgentWanted = new Map<string, string>()

/**
 * Reads an agent's transcript at most once at a time. A revision that moves on
 * while a read is in flight is read once more after it, however often it moved.
 */
function loadBgAgent(key: string, revision: string, read: () => Promise<ToolCall[] | null>): Promise<void> {
  bgAgentWanted.set(key, revision)
  const running = bgAgentLoads.get(key)
  if (running) return running
  const load = (async () => {
    try {
      for (let wanted = revision; bgAgentCache.get(key)?.revision !== wanted; wanted = bgAgentWanted.get(key)!) {
        const toolCalls = await read()
        if (!toolCalls) return
        bgAgentCache.set(key, { revision: wanted, toolCalls })
      }
    } finally {
      bgAgentLoads.delete(key)
    }
  })()
  bgAgentLoads.set(key, load)
  return load
}

export function useFileChangesData(session: SessionView) {
  const canAccessHostFiles = useCapability("hostFiles")
  const { sessionSource } = useSessionControls()
  const dirName = sessionSource?.dirName
  const isCodexSession = agentKindForDirName(dirName) === "codex"

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

  // Claude background agents and completed Codex child rollouts keep their file
  // operations in their own JSONL. Each progress message an agent leaves here
  // is a line it wrote there, so the newest one is the revision of that file.
  const bgAgentsToLoad = useMemo(() => {
    const revisions = new Map<string, string>()
    for (const turn of session.turns) {
      for (const msg of turn.subAgentActivity) {
        const codexAgentFinished = isCodexSession &&
          (msg.status === "completed" || msg.status === "failed" || msg.status === "interrupted")
        if ((msg.isBackground || codexAgentFinished) && msg.toolCalls.length === 0) {
          revisions.set(msg.agentId, `${msg.timestamp}:${msg.status ?? ""}`)
        }
      }
    }
    return [...revisions].map(([agentId, revision]) => ({ agentId, revision }))
  }, [session.turns, totalToolCallCount, isCodexSession]) // eslint-disable-line react-hooks/exhaustive-deps

  const [bgToolCalls, setBgToolCalls] = useState<Map<string, ToolCall[]>>(new Map())

  useEffect(() => {
    if (!dirName || !session.sessionId || bgAgentsToLoad.length === 0) return
    let cancelled = false
    const keyOf = (agentId: string) => deviceScopedKey(`${dirName}/${session.sessionId}/${agentId}`)
    const show = () => {
      if (cancelled) return
      setBgToolCalls((current) => {
        const next = new Map<string, ToolCall[]>()
        for (const { agentId } of bgAgentsToLoad) {
          const toolCalls = bgAgentCache.get(keyOf(agentId))?.toolCalls
          if (toolCalls) next.set(agentId, toolCalls)
        }
        return next.size === current.size && [...next].every(([agentId, toolCalls]) => current.get(agentId) === toolCalls) ? current : next
      })
    }
    show()
    for (const { agentId, revision } of bgAgentsToLoad) {
      const key = keyOf(agentId)
      if (bgAgentCache.get(key)?.revision === revision) continue
      void loadBgAgent(key, revision, async () => {
        try {
          const url = `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(session.sessionId)}` +
            `/subagents/agent-${encodeURIComponent(agentId)}.jsonl`
          const res = await authFetch(url)
          if (!res.ok) { void res.body?.cancel(); return null }
          const parsed = parseSubagentJsonl(await res.text(), agentId)
          return parsed.flatMap((msg) => expandEditToolCalls(msg.toolCalls, session.cwd))
        } catch { return null }
      }).then(show)
    }
    return () => { cancelled = true }
  }, [dirName, session.sessionId, session.cwd, bgAgentsToLoad])

  const fileChanges = useMemo(() => {
    const changes: FileChange[] = []
    const processedBgAgents = new Set<string>()
    for (let turnIndex = 0; turnIndex < session.turns.length; turnIndex++) {
      const turn = session.turns[turnIndex]
      for (const tc of expandEditToolCalls(turn.toolCalls, session.cwd)) {
        changes.push({ turnIndex, toolCall: tc })
      }
      for (const msg of turn.subAgentActivity) {
        // For foreground sub-agents with inline tool calls
        for (const tc of expandEditToolCalls(msg.toolCalls, session.cwd)) {
          changes.push({ turnIndex, toolCall: tc, agentId: msg.agentId })
        }
        // Use fetched tool calls for Claude background agents and Codex child
        // rollouts. Process each agent once to avoid duplication across turns.
        if ((msg.isBackground || isCodexSession) && msg.toolCalls.length === 0 && !processedBgAgents.has(msg.agentId)) {
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
  }, [totalToolCallCount, session.turns, bgToolCalls, isCodexSession])

  // Fetch actual file contents from disk for line number resolution
  const fileRevisions = useMemo(() => {
    const revisions = new Map<string, string>()
    for (const { toolCall } of fileChanges) {
      const path = getToolCallFilePath(toolCall)
      if (path) revisions.set(path, JSON.stringify([toolCall.id, toolCall.input, toolCall.result]))
    }
    return JSON.stringify([...revisions])
  }, [fileChanges])
  const scope = deviceScopedKey(JSON.stringify([dirName, session.sessionId, session.cwd]))
  const [fileContents, setFileContents] = useState<Map<string, string>>(new Map())
  const fetchedFiles = useRef(new Map<string, { revision: string; text: string }>())
  const [refreshVersion, setRefreshVersion] = useState(0)
  useEffect(() => {
    const refresh = () => setRefreshVersion((version) => version + 1)
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [])
  useEffect(() => { fetchedFiles.current = new Map() }, [scope, sessionSource?.loadId, refreshVersion])

  useEffect(() => {
    const revisions = JSON.parse(fileRevisions) as [string, string][]
    if (!canAccessHostFiles || revisions.length === 0) {
      setFileContents((current) => current.size ? new Map() : current)
      return
    }
    let cancelled = false
    const cache = fetchedFiles.current
    Promise.all(revisions.map(async ([path, revision]) => {
      const cached = cache.get(path)
      if (cached?.revision === revision) return [path, cached.text] as const
      try {
        const response = await authFetch(`/api/file-content?path=${encodeURIComponent(path)}`)
        if (!response.ok) return null
        const text = await response.text()
        if (cancelled) return null
        cache.set(path, { revision, text })
        return [path, text] as const
      } catch { return null }
    })).then((results) => {
      if (cancelled) return
      const next = new Map<string, string>()
      for (const result of results) if (result) next.set(...result)
      for (const path of cache.keys()) if (!next.has(path)) cache.delete(path)
      setFileContents((current) => current.size === next.size && [...next].every(([path, text]) => current.get(path) === text) ? current : next)
    })
    return () => { cancelled = true }
  }, [canAccessHostFiles, fileRevisions, scope, sessionSource?.loadId, refreshVersion])

  const lastTurnIndex = session.turns.length - 1

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
    lastTurnIndex,
    agentMap,
  }
}

// ── Grouped file types & builder ──────────────────────────────────────────

/** A single edit/write operation with its before/after strings. */
export interface IndividualEdit {
  id: string
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
    diffLineCounts: tc.diffLineCounts,
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
        id: fc.toolCall.id,
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

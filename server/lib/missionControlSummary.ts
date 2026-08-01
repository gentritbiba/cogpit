/**
 * Incremental per-session summaries for the Mission Control grid.
 *
 * Re-parsing every live session's JSONL on every poll is not affordable: live
 * files grow constantly, so an mtime-keyed cache always misses on exactly the
 * sessions the grid cares about. Instead each file keeps a running accumulator
 * plus the byte offset it has consumed, and a poll reads only the bytes appended
 * since last time. Steady-state cost is proportional to new agent output, not to
 * session size. A file that shrank or was replaced falls back to a full read.
 */

import { open, stat } from "node:fs/promises"
import { computeNetDiff, diffLineCount, type EditOp } from "../../shared/diff-utils"
import { computeContextUsage } from "../../shared/session/contextWindow"
import { getToolSummary } from "../../shared/session/toolSummary"
import type {
  MissionControlContext,
  MissionControlFileChange,
  MissionControlSummary,
} from "../../shared/contracts/missionControl"

/** Tool names shown in the card trail. */
const TRAIL_LENGTH = 3
/** Changed files listed per card before collapsing into "+N more". */
const MAX_FILES_LISTED = 4
/**
 * Edit ops retained per file for exact net-diff math. Older ops beyond this are
 * folded into a summed carry, which can over-count when the same hunk is edited
 * repeatedly — an acceptable trade for bounded memory on very long sessions.
 */
const MAX_OPS_PER_FILE = 60
/** Unresolved tool_use ids tracked per session, to find the in-flight call. */
const MAX_PENDING_TOOL_USES = 64
/** Assistant prose kept for the card preview. */
const PREVIEW_LIMIT = 240

interface FileAccumulator {
  ops: EditOp[]
  carryAdd: number
  carryDel: number
}

interface SessionAccumulator {
  startedAt: string | null
  lastEventAt: string | null
  model: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  context: MissionControlContext | null
  turnCount: number
  toolTrail: string[]
  totalToolCalls: number
  files: Map<string, FileAccumulator>
  lastAssistantText: string | null
  /** tool_use id → the call, until its tool_result arrives. */
  pendingToolUses: Map<string, { name: string; summary: string }>
  lastToolErrored: boolean
}

interface CacheEntry {
  mtimeMs: number
  /** Bytes of the file already folded into `acc`. */
  parsedBytes: number
  /** Trailing bytes that did not end in a newline yet. */
  pendingLine: string
  acc: SessionAccumulator
}

const cache = new Map<string, CacheEntry>()
/** Memory backstop — the grid only ever asks about a couple dozen sessions. */
const MAX_CACHE_ENTRIES = 200

function createAccumulator(): SessionAccumulator {
  return {
    startedAt: null,
    lastEventAt: null,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    context: null,
    turnCount: 0,
    toolTrail: [],
    totalToolCalls: 0,
    files: new Map(),
    lastAssistantText: null,
    pendingToolUses: new Map(),
    lastToolErrored: false,
  }
}

function recordEdit(acc: SessionAccumulator, path: string, op: EditOp): void {
  let entry = acc.files.get(path)
  if (!entry) {
    entry = { ops: [], carryAdd: 0, carryDel: 0 }
    acc.files.set(path, entry)
  }
  entry.ops.push(op)
  while (entry.ops.length > MAX_OPS_PER_FILE) {
    const evicted = entry.ops.shift()!
    const counts = diffLineCount(evicted.oldString, evicted.newString)
    entry.carryAdd += counts.add
    entry.carryDel += counts.del
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** Fold one Edit/Write/NotebookEdit tool call into the file accumulator. */
function foldFileEdit(acc: SessionAccumulator, name: string, input: Record<string, unknown>): void {
  const path = str(input.file_path) || str(input.path) || str(input.notebook_path)
  if (!path) return

  if (name === "Write") {
    recordEdit(acc, path, { oldString: "", newString: str(input.content), isWrite: true })
    return
  }
  // MultiEdit-style batches carry an `edits` array; single edits carry the pair.
  const edits = Array.isArray(input.edits) ? input.edits : null
  if (edits) {
    for (const raw of edits) {
      const e = asRecord(raw)
      recordEdit(acc, path, {
        oldString: str(e.old_string),
        newString: str(e.new_string),
        isWrite: false,
      })
    }
    return
  }
  recordEdit(acc, path, {
    oldString: str(input.old_string),
    newString: str(input.new_string),
    isWrite: false,
  })
}

function foldAssistant(acc: SessionAccumulator, entry: Record<string, unknown>): void {
  const message = asRecord(entry.message)
  const model = str(message.model)
  if (model) acc.model = model

  const usage = asRecord(message.usage)
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0
  const cacheRead =
    typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0
  const cacheCreation =
    typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0
  acc.inputTokens += input
  acc.outputTokens += output
  acc.cacheReadTokens += cacheRead
  acc.cacheCreationTokens += cacheCreation

  if (input || output || cacheRead || cacheCreation) {
    // Latest response wins: it reports the whole window the model is carrying.
    const usageResult = computeContextUsage(usage, model || acc.model || "")
    acc.context = {
      used: usageResult.used,
      limit: usageResult.limit,
      percent: Math.round(usageResult.percent),
    }
  }

  const content = Array.isArray(message.content) ? message.content : []
  for (const raw of content) {
    const block = asRecord(raw)
    if (block.type === "text") {
      const text = str(block.text).trim()
      if (text) acc.lastAssistantText = text.slice(0, PREVIEW_LIMIT)
      continue
    }
    if (block.type !== "tool_use") continue

    const name = str(block.name)
    if (!name) continue
    const toolInput = asRecord(block.input)
    acc.totalToolCalls += 1
    acc.toolTrail.push(name)
    if (acc.toolTrail.length > TRAIL_LENGTH) acc.toolTrail.shift()

    const id = str(block.id)
    if (id) {
      acc.pendingToolUses.set(id, { name, summary: getToolSummary({ name, input: toolInput }) })
      while (acc.pendingToolUses.size > MAX_PENDING_TOOL_USES) {
        const oldest = acc.pendingToolUses.keys().next().value
        if (oldest === undefined) break
        acc.pendingToolUses.delete(oldest)
      }
    }

    if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
      foldFileEdit(acc, name, toolInput)
    }
  }
}

function foldUser(acc: SessionAccumulator, entry: Record<string, unknown>): void {
  const message = asRecord(entry.message)
  const content = message.content
  if (typeof content === "string") {
    acc.turnCount += 1
    return
  }
  if (!Array.isArray(content)) return

  let sawToolResult = false
  for (const raw of content) {
    const block = asRecord(raw)
    if (block.type !== "tool_result") continue
    sawToolResult = true
    const id = str(block.tool_use_id)
    if (id) acc.pendingToolUses.delete(id)
    acc.lastToolErrored = block.is_error === true
  }
  // A user line carrying only tool results is the agent's own loop, not a turn.
  if (!sawToolResult) acc.turnCount += 1
}

function foldLine(acc: SessionAccumulator, line: string): void {
  const trimmed = line.trim()
  if (!trimmed) return

  let entry: Record<string, unknown>
  try {
    entry = asRecord(JSON.parse(trimmed))
  } catch {
    return
  }

  const timestamp = str(entry.timestamp)
  if (timestamp) {
    if (!acc.startedAt) acc.startedAt = timestamp
    acc.lastEventAt = timestamp
  }

  switch (entry.type) {
    case "assistant":
      foldAssistant(acc, entry)
      break
    case "user":
      foldUser(acc, entry)
      break
    default:
      break
  }
}

function buildFiles(acc: SessionAccumulator): {
  files: MissionControlFileChange[]
  filesTotal: { count: number; additions: number; deletions: number }
} {
  const all: MissionControlFileChange[] = []
  let additions = 0
  let deletions = 0

  for (const [path, entry] of acc.files) {
    const net = computeNetDiff(entry.ops)
    const add = net.addCount + entry.carryAdd
    const del = net.delCount + entry.carryDel
    if (add === 0 && del === 0) continue
    all.push({ path, additions: add, deletions: del })
    additions += add
    deletions += del
  }

  all.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
  return {
    files: all.slice(0, MAX_FILES_LISTED),
    filesTotal: { count: all.length, additions, deletions },
  }
}

function toSummary(sessionId: string, acc: SessionAccumulator): MissionControlSummary {
  const { files, filesTotal } = buildFiles(acc)
  const started = acc.startedAt ? Date.parse(acc.startedAt) : NaN
  const last = acc.lastEventAt ? Date.parse(acc.lastEventAt) : NaN
  const elapsedMs =
    Number.isFinite(started) && Number.isFinite(last) ? Math.max(0, last - started) : 0

  // The newest still-unresolved tool call is what the agent is doing right now.
  let currentTool: { name: string; summary: string } | null = null
  for (const value of acc.pendingToolUses.values()) currentTool = value

  return {
    sessionId,
    model: acc.model,
    startedAt: acc.startedAt,
    lastEventAt: acc.lastEventAt,
    elapsedMs,
    turnCount: acc.turnCount,
    tokens: {
      input: acc.inputTokens,
      output: acc.outputTokens,
      cacheRead: acc.cacheReadTokens,
      cacheCreation: acc.cacheCreationTokens,
      total: acc.inputTokens + acc.outputTokens,
    },
    context: acc.context,
    currentTool,
    toolTrail: [...acc.toolTrail],
    totalToolCalls: acc.totalToolCalls,
    files,
    filesTotal,
    lastAssistantText: acc.lastAssistantText,
    lastToolErrored: acc.lastToolErrored,
  }
}

/** Read `[from, to)` of a file as UTF-8. */
async function readRange(filePath: string, from: number, to: number): Promise<string> {
  const length = to - from
  if (length <= 0) return ""
  const handle = await open(filePath, "r")
  try {
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, from)
    return buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
}

function evictIfNeeded(): void {
  if (cache.size <= MAX_CACHE_ENTRIES) return
  const overflow = cache.size - MAX_CACHE_ENTRIES
  let removed = 0
  for (const key of cache.keys()) {
    cache.delete(key)
    if (++removed >= overflow) break
  }
}

/**
 * Summarize one session file, reusing the cached accumulator and folding only
 * bytes appended since the previous call.
 */
export async function summarizeSession(
  sessionId: string,
  filePath: string,
): Promise<MissionControlSummary | null> {
  let size: number
  let mtimeMs: number
  try {
    const info = await stat(filePath)
    size = info.size
    mtimeMs = info.mtimeMs
  } catch {
    return null
  }

  let entry = cache.get(filePath)
  // A file that shrank was rewritten, so the accumulator no longer describes it.
  if (entry && entry.parsedBytes > size) entry = undefined
  if (!entry) {
    entry = { mtimeMs, parsedBytes: 0, pendingLine: "", acc: createAccumulator() }
    cache.set(filePath, entry)
    evictIfNeeded()
  }

  if (entry.parsedBytes < size) {
    const chunk = await readRange(filePath, entry.parsedBytes, size)
    const text = entry.pendingLine + chunk
    const lines = text.split("\n")
    // The final element is whatever follows the last newline — possibly a
    // half-written line, which must wait for the rest of the append.
    entry.pendingLine = lines.pop() ?? ""
    for (const line of lines) foldLine(entry.acc, line)
    entry.parsedBytes = size
    entry.mtimeMs = mtimeMs
  }

  return toSummary(sessionId, entry.acc)
}

/** Test seam — drops all cached accumulators. */
export function resetMissionControlCache(): void {
  cache.clear()
}

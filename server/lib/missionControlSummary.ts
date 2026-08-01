/**
 * Incremental per-session summaries for the Mission Control grid.
 *
 * Live session files grow constantly, so an mtime-keyed cache would miss on
 * exactly the sessions the grid cares about. Each file instead keeps a running
 * accumulator plus the byte offset already folded into it, and a poll reads only
 * the bytes appended since last time. A file that shrank was rewritten, so its
 * accumulator is dropped and the file is read from the start again.
 */

import { open, stat } from "node:fs/promises"
import { computeNetDiff, type EditOp } from "../../shared/diff-utils"
import { computeContextUsage } from "../../shared/session/contextWindow"
import { getToolSummary } from "../../shared/session/toolSummary"
import type {
  MissionControlContext,
  MissionControlCurrentTool,
  MissionControlFileChange,
  MissionControlSummary,
  MissionControlTokens,
} from "../../shared/contracts/missionControl"

/** Tool names shown in the card trail. */
const TRAIL_LENGTH = 3
/** Changed files listed per card before collapsing into "+N more". */
const MAX_FILES_LISTED = 4
/** Assistant prose kept for the card preview. */
const PREVIEW_LIMIT = 240
/** Memory backstop — the grid only ever asks about a couple dozen sessions. */
const MAX_CACHE_ENTRIES = 200

interface SessionAccumulator {
  startedAt: string | null
  lastEventAt: string | null
  model: string | null
  /** `total` is derived on the way out, so it is not tracked here. */
  tokens: Omit<MissionControlTokens, "total">
  context: MissionControlContext | null
  turnCount: number
  toolTrail: string[]
  totalToolCalls: number
  /** File path → every edit op against it, in order, for exact net-diff math. */
  files: Map<string, EditOp[]>
  lastAssistantText: string | null
  /** tool_use id → the call, until its tool_result arrives. */
  pendingToolUses: Map<string, MissionControlCurrentTool>
  lastToolErrored: boolean
}

interface CacheEntry {
  /** Bytes of the file already folded into `acc`. */
  parsedBytes: number
  /** Trailing bytes that did not end in a newline yet. */
  pendingLine: string
  acc: SessionAccumulator
  /** Built payload, reused until new bytes arrive. */
  summary: MissionControlSummary | null
}

const cache = new Map<string, CacheEntry>()

function createAccumulator(): SessionAccumulator {
  return {
    startedAt: null,
    lastEventAt: null,
    model: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0
}

function recordEdit(acc: SessionAccumulator, path: string, op: EditOp): void {
  const ops = acc.files.get(path)
  if (ops) ops.push(op)
  else acc.files.set(path, [op])
}

/** Fold one Edit/Write/MultiEdit/NotebookEdit call into the file accumulator. */
function foldFileEdit(acc: SessionAccumulator, name: string, input: Record<string, unknown>): void {
  const path = str(input.file_path) || str(input.path) || str(input.notebook_path)
  if (!path) return

  if (name === "Write") {
    recordEdit(acc, path, { oldString: "", newString: str(input.content), isWrite: true })
    return
  }
  // MultiEdit-style batches carry an `edits` array; a single edit carries the
  // old/new pair on the input itself, so treat it as a batch of one.
  const edits = Array.isArray(input.edits) ? input.edits : [input]
  for (const raw of edits) {
    const edit = asRecord(raw)
    recordEdit(acc, path, {
      oldString: str(edit.old_string),
      newString: str(edit.new_string),
      isWrite: false,
    })
  }
}

function foldAssistant(acc: SessionAccumulator, entry: Record<string, unknown>): void {
  const message = asRecord(entry.message)
  const model = str(message.model)
  if (model) acc.model = model

  const usage = asRecord(message.usage)
  const input = num(usage.input_tokens)
  const output = num(usage.output_tokens)
  const cacheRead = num(usage.cache_read_input_tokens)
  const cacheCreation = num(usage.cache_creation_input_tokens)
  acc.tokens.input += input
  acc.tokens.output += output
  acc.tokens.cacheRead += cacheRead
  acc.tokens.cacheCreation += cacheCreation

  if (input || output || cacheRead || cacheCreation) {
    // Latest response wins: it reports the whole window the model is carrying.
    const context = computeContextUsage(usage, model || acc.model || "")
    acc.context = {
      used: context.used,
      limit: context.limit,
      percent: Math.round(context.percent),
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
    }

    if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
      foldFileEdit(acc, name, toolInput)
    }
  }
}

function foldUser(acc: SessionAccumulator, entry: Record<string, unknown>): void {
  const content = asRecord(entry.message).content
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
    acc.startedAt ??= timestamp
    acc.lastEventAt = timestamp
  }

  if (entry.type === "assistant") foldAssistant(acc, entry)
  else if (entry.type === "user") foldUser(acc, entry)
}

function buildFiles(acc: SessionAccumulator): Pick<MissionControlSummary, "files" | "filesTotal"> {
  const all: MissionControlFileChange[] = []
  let additions = 0
  let deletions = 0

  for (const [path, ops] of acc.files) {
    const net = computeNetDiff(ops)
    if (net.addCount === 0 && net.delCount === 0) continue
    all.push({ path, additions: net.addCount, deletions: net.delCount })
    additions += net.addCount
    deletions += net.delCount
  }

  all.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
  return {
    files: all.slice(0, MAX_FILES_LISTED),
    filesTotal: { count: all.length, additions, deletions },
  }
}

function toSummary(sessionId: string, acc: SessionAccumulator): MissionControlSummary {
  const started = acc.startedAt ? Date.parse(acc.startedAt) : NaN
  const last = acc.lastEventAt ? Date.parse(acc.lastEventAt) : NaN
  const elapsedMs =
    Number.isFinite(started) && Number.isFinite(last) ? Math.max(0, last - started) : 0

  // The newest still-unresolved tool call is what the agent is doing right now.
  let currentTool: MissionControlCurrentTool | null = null
  for (const pending of acc.pendingToolUses.values()) currentTool = pending

  return {
    sessionId,
    model: acc.model,
    startedAt: acc.startedAt,
    lastEventAt: acc.lastEventAt,
    elapsedMs,
    turnCount: acc.turnCount,
    tokens: { ...acc.tokens, total: acc.tokens.input + acc.tokens.output },
    context: acc.context,
    currentTool,
    toolTrail: [...acc.toolTrail],
    totalToolCalls: acc.totalToolCalls,
    ...buildFiles(acc),
    lastAssistantText: acc.lastAssistantText,
    lastToolErrored: acc.lastToolErrored,
  }
}

/** Read `[from, to)` of a file as UTF-8. */
async function readRange(filePath: string, from: number, to: number): Promise<string> {
  const handle = await open(filePath, "r")
  try {
    const buffer = Buffer.allocUnsafe(to - from)
    const { bytesRead } = await handle.read(buffer, 0, to - from, from)
    return buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
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
  try {
    size = (await stat(filePath)).size
  } catch {
    return null
  }

  let entry = cache.get(filePath)
  // A file that shrank was rewritten, so the accumulator no longer describes it.
  if (entry && entry.parsedBytes > size) entry = undefined
  if (!entry) {
    entry = { parsedBytes: 0, pendingLine: "", acc: createAccumulator(), summary: null }
    cache.set(filePath, entry)
    if (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
  }

  if (entry.parsedBytes < size) {
    const text = entry.pendingLine + (await readRange(filePath, entry.parsedBytes, size))
    const lines = text.split("\n")
    // The final element is whatever follows the last newline — possibly a
    // half-written line, which must wait for the rest of the append.
    entry.pendingLine = lines.pop() ?? ""
    for (const line of lines) foldLine(entry.acc, line)
    entry.parsedBytes = size
    entry.summary = null
  }

  entry.summary ??= toSummary(sessionId, entry.acc)
  return entry.summary
}

/** Test seam — drops all cached accumulators. */
export function resetMissionControlCache(): void {
  cache.clear()
}

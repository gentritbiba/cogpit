import type { EditOp } from "../../shared/diff-utils"
import { getToolSummary } from "../../shared/session/toolSummary"
import type {
  MissionControlContext,
  MissionControlCurrentTool,
  MissionControlTokens,
} from "../../shared/contracts/missionControl"

/**
 * The running state one Mission Control card is folded into, and the
 * agent-neutral operations every fold applies to it. What each agent's records
 * *mean* lives in `./summaryFolds`.
 */

/** Tool names shown in the card trail. */
const TRAIL_LENGTH = 3
/** Assistant prose kept for the card preview — the card's main body. */
const PREVIEW_LIMIT = 600

export interface SessionAccumulator {
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
  /** Calls already counted, for an agent that announces the same call twice. */
  announcedToolUses: Set<string>
  /** Edit inputs already folded, so a repeated announcement adds no diff. */
  foldedFileEdits: Set<string>
  lastToolErrored: boolean
}

export function createAccumulator(): SessionAccumulator {
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
    announcedToolUses: new Set(),
    foldedFileEdits: new Set(),
    lastToolErrored: false,
  }
}

/**
 * Never null, so folds can walk a chain of unknown transcript fields without
 * guarding each hop. Deliberately not `shared/objects`'s `asRecord`, which
 * returns null and rejects arrays.
 */
export function asRecordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function num(value: unknown): number {
  return typeof value === "number" ? value : 0
}

export function recordEdit(acc: SessionAccumulator, path: string, op: EditOp): void {
  const ops = acc.files.get(path)
  if (ops) ops.push(op)
  else acc.files.set(path, [op])
}

/** Count a tool call and push it onto the trail the card shows. */
export function noteToolCall(acc: SessionAccumulator, name: string): void {
  acc.totalToolCalls += 1
  acc.toolTrail.push(name)
  if (acc.toolTrail.length > TRAIL_LENGTH) acc.toolTrail.shift()
}

/** Remember a call until its result arrives; the newest one is "current". */
export function notePendingTool(
  acc: SessionAccumulator,
  id: string,
  name: string,
  input: Record<string, unknown>,
): void {
  if (id) acc.pendingToolUses.set(id, { name, summary: getToolSummary({ name, input }) })
}

export function isFileEditTool(name: string): boolean {
  return name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit"
}

/** Fold one Edit/Write/MultiEdit/NotebookEdit call into the file accumulator. */
export function foldFileEdit(acc: SessionAccumulator, name: string, input: Record<string, unknown>): boolean {
  const path = str(input.file_path) || str(input.path) || str(input.notebook_path)
  if (!path) return false

  if (name === "Write") {
    recordEdit(acc, path, { oldString: "", newString: str(input.content), isWrite: true })
    return true
  }
  // MultiEdit-style batches carry an `edits` array; a single edit carries the
  // old/new pair on the input itself, so treat it as a batch of one.
  const edits = Array.isArray(input.edits) ? input.edits : [input]
  for (const raw of edits) {
    const edit = asRecordOrEmpty(raw)
    recordEdit(acc, path, {
      oldString: str(edit.old_string),
      newString: str(edit.new_string),
      isWrite: false,
    })
  }
  return true
}

/** Keep the newest assistant prose as the card preview. */
export function notePreview(acc: SessionAccumulator, text: string): void {
  const trimmed = text.trim()
  if (trimmed) acc.lastAssistantText = trimmed.slice(0, PREVIEW_LIMIT)
}

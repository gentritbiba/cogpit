// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Claude Code's transcript grammar: detection, parsing, incremental append,
 * header metadata and status derivation.
 *
 * This is a peer of `./codex` and `./copilot`. Until it existed, Claude's
 * grammar was implicit — spread across `./parser`, `./turnBuilder` and the
 * untagged fallback arm of several sniffers — which is what forced every
 * consumer to hand-write an if/else chain over the three CLIs.
 *
 * It knows nothing about its siblings and nothing about the registry that picks
 * between them: `./agents` imports this module, never the other way round.
 */
import { isAssistantMessage } from "./messageTypeGuards"
import { computeStats, createEmptySessionStats } from "./sessionStats"
import { buildTurns, buildTurnsWithStarts, findTurnStartIndices, pairAgentMessageReplies } from "./turnBuilder"
import type {
  ParseSessionOptions,
  ParsedSession,
  RawMessage,
  RawRecord,
  SessionStatus,
  SessionStatusInfo,
} from "./types"

// ── Detection ───────────────────────────────────────────────────────────────

/**
 * Unconditionally true: this is the terminal arm of transcript detection.
 *
 * Detection ORDER is the contract. `AGENT_KINDS` ends with this format, so a
 * transcript only reaches it after every positively-discriminated format has
 * declined it. Spelling the fallback out as "not the others" instead would make
 * each new CLI edit this function and re-introduce the mutual references the
 * registry exists to remove.
 */
export function isClaudeSessionText(): boolean {
  return true
}

// ── Parsing ─────────────────────────────────────────────────────────────────

export interface ClaudeMetadata {
  sessionId: string
  version: string
  gitBranch: string
  cwd: string
  slug: string
  name: string
  model: string
  branchedFrom?: { sessionId: string; turnIndex?: number | null }
}

function parseRecords(lines: readonly string[]): RawMessage[] {
  const messages: RawMessage[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      messages.push(JSON.parse(trimmed) as RawMessage)
    } catch {
      // skip malformed lines
    }
  }
  return messages
}

function parseLines(jsonlText: string): RawMessage[] {
  return parseRecords(jsonlText.split("\n"))
}

function extractSessionMetadata(messages: RawMessage[]): ClaudeMetadata {
  const meta: ClaudeMetadata = { sessionId: "", version: "", gitBranch: "", cwd: "", slug: "", name: "", model: "", branchedFrom: undefined }

  for (const msg of messages) {
    if (msg.sessionId && !meta.sessionId) meta.sessionId = msg.sessionId
    if (msg.version && !meta.version) meta.version = msg.version
    if (msg.gitBranch && !meta.gitBranch) meta.gitBranch = msg.gitBranch
    if (msg.cwd && !meta.cwd) meta.cwd = msg.cwd
    if (msg.slug && !meta.slug) meta.slug = msg.slug
    if ((msg as Record<string, unknown>).name && !meta.name) meta.name = (msg as Record<string, unknown>).name as string
    if ((msg as Record<string, unknown>).branchedFrom && !meta.branchedFrom) {
      meta.branchedFrom = (msg as Record<string, unknown>).branchedFrom as typeof meta.branchedFrom
    }
    if (isAssistantMessage(msg) && msg.message.model && !meta.model) {
      meta.model = msg.message.model
    }
    if (meta.sessionId && meta.version && meta.gitBranch && meta.cwd && meta.model) break
  }

  return meta
}

/** Cheap header metadata read from already-split transcript lines. */
export function extractClaudeMetadataFromLines(lines: readonly string[]): ClaudeMetadata {
  return extractSessionMetadata(parseRecords(lines))
}

export function parseClaudeSession(jsonlText: string, options?: ParseSessionOptions): ParsedSession {
  const rawMessages = parseLines(jsonlText)
  const metadata = extractSessionMetadata(rawMessages)
  const turns = buildTurns(rawMessages)
  const stats = options?.skipStats ? createEmptySessionStats(turns.length) : computeStats(turns)

  return {
    ...metadata,
    turns,
    stats,
    rawMessages: options?.skipStats ? [] : rawMessages,
    agentKind: "claude" as const,
  }
}

/**
 * Incrementally append new JSONL lines to an existing parsed session.
 * Avoids re-parsing all turns from scratch — only re-processes the last
 * (potentially incomplete) turn and any new messages.
 */
export function appendClaudeSession(
  existing: ParsedSession,
  newJsonlText: string,
): ParsedSession {
  const newMessages = parseLines(newJsonlText)
  if (newMessages.length === 0) return existing

  // Only this format's records reach here, so they use Claude's discriminated
  // message union and are safe to pass to the Claude turn builder.
  const existingRawMessages = existing.rawMessages as RawMessage[]
  const allRawMessages = [...existingRawMessages, ...newMessages]

  // Only the last turn can still change, so keep every turn before it and
  // rebuild from where it started. Both the cut point and the keep-count come
  // from `turnStarts` so they cannot disagree — even for a window that begins
  // mid-turn (bottom-first loading) and therefore has no turn-starting user
  // record to walk back to.
  const turnStarts = findTurnStartIndices(existingRawMessages)
  // Turns paged in above the loaded window have no raw messages behind them.
  const historyTurnCount = Math.max(0, existing.turns.length - turnStarts.length)
  let rebuildFromTurn = Math.max(0, turnStarts.length - 1)

  // Claude Code can flush sub-agent progress events AFTER the parent turn's
  // tool_result and even after the next turn has started. When that happens we
  // rebuild from the turn that owns the tool call so the sub-agent content
  // block lands in the correct turn.
  const progressParentIds = new Set<string>()
  for (const msg of newMessages) {
    if (msg.type === "progress") {
      const parentId = (msg as typeof newMessages[0] & { parentToolUseID?: string }).parentToolUseID
      if (parentId) progressParentIds.add(parentId)
    }
  }

  if (progressParentIds.size > 0) {
    for (let t = rebuildFromTurn - 1; t >= 0; t--) {
      const turn = existing.turns[historyTurnCount + t]
      if (turn?.toolCalls.some((tc) => progressParentIds.has(tc.id))) {
        rebuildFromTurn = t
        break
      }
    }
  }

  // With no turns in the window at all, there is nothing to rebuild — parse
  // the new messages on their own and keep everything already known.
  const rebuildFrom = turnStarts[rebuildFromTurn] ?? existingRawMessages.length
  const keptTurns = existing.turns.slice(0, historyTurnCount + rebuildFromTurn)
  const tailTurns = buildTurns(allRawMessages.slice(rebuildFrom))

  // Only the rebuilt tail passed through pairing, and it cannot see the kept
  // turns above it — so a peer message two or more turns back would lose the
  // reply it already had the moment the next line lands.
  const allTurns = pairAgentMessageReplies([...keptTurns, ...tailTurns])
  const stats = computeStats(allTurns)

  // Preserve metadata from existing (already extracted)
  return {
    sessionId: existing.sessionId,
    version: existing.version,
    gitBranch: existing.gitBranch,
    cwd: existing.cwd,
    slug: existing.slug,
    name: existing.name,
    model: existing.model || (allTurns.length > 0 ? allTurns[allTurns.length - 1].model || "" : ""),
    turns: allTurns,
    stats,
    rawMessages: allRawMessages,
    branchedFrom: existing.branchedFrom,
    agentKind: existing.agentKind,
  }
}

// ── Background-task signals ─────────────────────────────────────────────────
//
// The turn can end (stop_reason "end_turn") while background agents or
// workflows launched with the Agent/Workflow tools are still running. Their
// launch is recorded as a user tool_result line whose toolUseResult has
// status "async_launched"; their completion arrives later as a
// <task-notification> (queued, then delivered as an attachment, then consumed
// as a user message) that re-invokes the agent. Until every launch has
// notified, the session is waiting on agents — not on the user.
//
// Background Bash tasks (toolUseResult.backgroundTaskId) are deliberately NOT
// counted: long-lived commands like dev servers never exit, so treating them
// as pending would pin the status forever. Their completion notifications
// still flow through the wakeup detection below.

const TASK_NOTIFICATION_MARKER = "<task-notification>"
const TASK_ID_RE = /<task-id>([^<]+)<\/task-id>/g
const TOOL_USE_ID_RE = /<tool-use-id>([^<]+)<\/tool-use-id>/g

interface ClaudeBackgroundWork {
  /** Descriptions of launched agents/workflows with no completion signal yet */
  pendingDescriptions: string[]
  /** Completion notifications enqueued but not yet seen in any delivery-shaped record */
  undeliveredNotifications: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Extract every string that could carry a <task-notification> from a user message. */
function userMessageTexts(msg: RawRecord): string[] {
  const message = isObject(msg.message) ? msg.message : null
  const content = message?.content
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []
  return content
    .filter((block): block is Record<string, unknown> => isObject(block) && typeof block.text === "string")
    .map((block) => block.text as string)
}

function collectClaudeBackgroundWork(rawMessages: readonly RawRecord[]): ClaudeBackgroundWork {
  const launches: Array<{ ids: string[]; description: string }> = []
  const resolved = new Set<string>()
  // Identity, not arithmetic: real transcripts write far more notification
  // enqueues than removes, so a counter latches positive and pins finished
  // sessions at "processing" forever. A notification is undelivered only while
  // its ids appear in an enqueue but in no delivery-shaped record yet.
  const queuedIds = new Set<string>()
  const deliveredIds = new Set<string>()

  function noteNotifications(text: string, sink?: Set<string>) {
    if (!text.includes(TASK_NOTIFICATION_MARKER)) return
    for (const match of text.matchAll(TASK_ID_RE)) {
      resolved.add(match[1])
      sink?.add(match[1])
    }
    for (const match of text.matchAll(TOOL_USE_ID_RE)) {
      resolved.add(match[1])
      sink?.add(match[1])
    }
  }

  for (const msg of rawMessages) {
    if (msg.type === "user") {
      const toolUseResult = isObject(msg.toolUseResult) ? msg.toolUseResult : null
      if (toolUseResult?.status === "async_launched") {
        const message = isObject(msg.message) ? msg.message : null
        const blocks = Array.isArray(message?.content) ? message.content : []
        const toolUseIds = blocks
          .filter((block): block is Record<string, unknown> => isObject(block) && block.type === "tool_result")
          .map((block) => block.tool_use_id)
        const ids = [toolUseResult.agentId, toolUseResult.taskId, ...toolUseIds]
          .filter((id): id is string => typeof id === "string" && id.length > 0)
        const description = [toolUseResult.description, toolUseResult.workflowName, toolUseResult.summary]
          .find((value): value is string => typeof value === "string" && value.length > 0) ?? ""
        if (ids.length > 0) launches.push({ ids, description })
      }
      for (const text of userMessageTexts(msg)) noteNotifications(text, deliveredIds)
      continue
    }

    if (msg.type === "assistant") {
      // A TaskStop call kills its task — no notification will ever arrive.
      const message = isObject(msg.message) ? msg.message : null
      const blocks = Array.isArray(message?.content) ? message.content : []
      for (const block of blocks) {
        if (!isObject(block) || block.type !== "tool_use" || block.name !== "TaskStop") continue
        const input = isObject(block.input) ? block.input : null
        const taskId = input?.task_id ?? input?.shell_id
        if (typeof taskId === "string") resolved.add(taskId)
      }
      continue
    }

    if (msg.type === "attachment") {
      const attachment = isObject(msg.attachment) ? msg.attachment : null
      if (typeof attachment?.prompt === "string") noteNotifications(attachment.prompt, deliveredIds)
      continue
    }

    if (msg.type === "queue-operation" && typeof msg.content === "string") {
      const op = (msg as { operation?: string }).operation
      noteNotifications(msg.content, op === "enqueue" ? queuedIds : deliveredIds)
    }
  }

  return {
    pendingDescriptions: launches
      .filter((launch) => !launch.ids.some((id) => resolved.has(id)))
      .map((launch) => launch.description),
    undeliveredNotifications: [...queuedIds].filter((id) => !deliveredIds.has(id)).length,
  }
}

function awaitingAgentsResult(pendingDescriptions: string[], pendingQueue: number): SessionStatusInfo {
  return {
    status: "awaiting_agents",
    pendingQueue,
    pendingAgents: pendingDescriptions.length,
    pendingAgentDescriptions: pendingDescriptions.filter((description) => description.length > 0),
  }
}

/** Derive status by walking backward through Claude Code's JSONL records. */
export function deriveClaudeSessionStatus(rawMessages: readonly RawRecord[]): SessionStatusInfo {
  let pendingEnqueues = 0
  let backgroundWork: ClaudeBackgroundWork | null = null
  // Set while walking backward when a <task-notification> attachment sits after
  // the last assistant message — the wakeup is being delivered right now.
  let deliveringNotification = false

  /** Build a status result with the current pending queue count. */
  function result(status: SessionStatus, toolName?: string): SessionStatusInfo {
    const info: SessionStatusInfo = { status, pendingQueue: Math.max(0, pendingEnqueues) }
    if (toolName) info.toolName = toolName
    return info
  }

  // Only needed once a turn has ended, so the scan is lazy — live turns
  // (tool_use/thinking) never pay for it.
  function getBackgroundWork(): ClaudeBackgroundWork {
    return (backgroundWork ??= collectClaudeBackgroundWork(rawMessages))
  }

  // Pre-pass: check if the latest meaningful event is a deferred hook_progress.
  // A deferred state means a PreToolUse hook returned decision:"defer", pausing
  // the session until `claude -p --resume <id>` re-evaluates it.
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const msg = rawMessages[i]
    // Skip queue-operations — they don't affect the deferred signal
    if (msg.type === "queue-operation") continue
    // Skip progress messages that are NOT hook_progress
    if (msg.type === "progress") {
      const data = (msg as { data?: { type?: string; decision?: string; hookSpecificOutput?: { permissionDecision?: string } } }).data
      if (data?.type === "hook_progress") {
        const decision = data.decision ?? data.hookSpecificOutput?.permissionDecision
        if (decision === "defer") return result("deferred")
      }
      // Any non-deferred progress message — stop looking for deferred
      break
    }
    // Any other message type breaks the deferred check
    break
  }

  // Walk backward to find the last meaningful signal
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const msg = rawMessages[i]

    // Track queue state. Task-notification wakeups are internal — they are not
    // user prompts waiting in the queue.
    if (msg.type === "queue-operation") {
      if (typeof msg.content === "string" && msg.content.includes(TASK_NOTIFICATION_MARKER)) continue
      const op = (msg as { operation?: string }).operation
      if (op === "enqueue") pendingEnqueues++
      else if (op === "dequeue" || op === "remove") pendingEnqueues--
      continue
    }

    // A task-notification attachment after the last assistant/user line means
    // the runtime is about to resume the agent with it.
    if (msg.type === "attachment") {
      const attachment = isObject(msg.attachment) ? msg.attachment : null
      if (attachment?.commandMode === "task-notification") deliveringNotification = true
      continue
    }

    if (msg.type === "assistant") {
      const message = msg.message as { stop_reason?: string | null; content?: Array<{ type: string; name?: string }> } | undefined
      const stopReason = message?.stop_reason

      if (stopReason === "end_turn") {
        // The turn ended, but the agent may still be waiting on background
        // agents rather than on the user.
        const work = getBackgroundWork()
        if (deliveringNotification || work.undeliveredNotifications > 0) return result("processing")
        if (work.pendingDescriptions.length > 0) {
          return awaitingAgentsResult(work.pendingDescriptions, Math.max(0, pendingEnqueues))
        }

        // Scan backward from here for real user activity (typically found immediately)
        let hasActivity = false
        for (let j = i - 1; j >= 0; j--) {
          const m = rawMessages[j]
          if (m.type === "user" && !(m as { isMeta?: boolean }).isMeta) { hasActivity = true; break }
        }
        return result(hasActivity ? "completed" : "idle")
      }
      if (stopReason === "tool_use") {
        const content = message?.content
        const toolUseBlock = content?.findLast?.((b) => b.type === "tool_use")
        return result("tool_use", toolUseBlock?.name)
      }
      // stop_reason is null -> streaming/thinking
      return result("thinking")
    }

    if (msg.type === "user") {
      const isMeta = (msg as { isMeta?: boolean }).isMeta
      if (isMeta) continue

      // User message (regular or tool result) -- waiting for assistant
      return result("processing")
    }

    // terminal_reason system messages — the session ended for a non-normal reason
    if (msg.type === "system" && (msg as { subtype?: string }).subtype === "terminal_reason") {
      const reason = (msg as { reason?: string }).reason
      if (reason) {
        return { status: "completed", terminalReason: reason, pendingQueue: Math.max(0, pendingEnqueues) }
      }
      continue
    }

    // Compaction markers — skip past them to find the real session state.
    // In-progress compaction is detected live via subagent file watcher (isCompacting),
    // so these finished-compaction markers should not lock the status to "compacting".
    if (msg.type === "summary") continue
    if (msg.type === "system" && (msg as { subtype?: string }).subtype === "compact_boundary") continue

    // Skip progress, system, etc.
  }

  return { status: "idle" }
}

// ── Branching ──────────────────────────────────────────────────────────────

/** A branch keeps the header record, renamed and pointed back at its origin. */
export function brandClaudeBranch(
  firstRecord: Record<string, unknown>,
  sessionId: string,
  turnIndex: number | null,
): { record: Record<string, unknown>; originalId: string } {
  const originalId = typeof firstRecord.sessionId === "string" ? firstRecord.sessionId : ""
  return {
    record: { ...firstRecord, sessionId, branchedFrom: { sessionId: originalId, turnIndex } },
    originalId,
  }
}

// ── Turn boundaries ─────────────────────────────────────────────────────────

/**
 * Indexes of the records that start a turn.
 *
 * A user record that carries *any* `tool_result` block is a continuation of the
 * turn in flight, not a new one — the CLI writes tool results back as user
 * records. This predicate is the one the client and the server both cut on, so
 * an off-by-one here writes a corrupted transcript rather than failing loudly.
 */
export function claudeTurnBoundaries(
  records: readonly Record<string, unknown>[],
): number[] {
  // Derived from the turn builder's own walk rather than a predicate that
  // restates its rule. The restatement had already drifted: it counted
  // `<task-notification>` wake-ups as new turns, while `buildTurns` folds them
  // into the turn in flight, so every boundary after one was off by a turn.
  return buildTurnsWithStarts(records as unknown as RawMessage[]).turnStartIndices
}

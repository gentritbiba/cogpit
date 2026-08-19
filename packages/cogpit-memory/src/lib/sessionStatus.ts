// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Derives the current session status from raw JSONL messages.
 * Walks backward from the last message to determine if the agent
 * is idle, thinking, calling tools, etc.
 *
 * This is a pure function — status is always derived from data,
 * never stored as app state.
 */

import { normalizeFunctionName } from "./codex-tool-normalization"

export type SessionStatus =
  | "idle"
  | "thinking"
  | "tool_use"
  | "processing"
  | "completed"
  | "compacting"
  | "deferred"
  | "awaiting_agents"

export interface SessionStatusInfo {
  status: SessionStatus
  /** Name of the tool currently being used (if status is tool_use) */
  toolName?: string
  /** Number of pending queue items (user messages waiting to be processed) */
  pendingQueue?: number
  /** Why the session terminated (from Claude Code's terminal_reason). Only set for non-normal endings. */
  terminalReason?: string
  /** Number of background agents/workflows still running (status awaiting_agents) */
  pendingAgents?: number
  /** Short descriptions of the pending background agents, oldest first */
  pendingAgentDescriptions?: string[]
}

type RawMsg = { type: string; [key: string]: unknown }

// ── Background-task signals (Claude) ────────────────────────────────────────
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
function userMessageTexts(msg: RawMsg): string[] {
  const message = isObject(msg.message) ? msg.message : null
  const content = message?.content
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []
  return content
    .filter((block): block is Record<string, unknown> => isObject(block) && typeof block.text === "string")
    .map((block) => block.text as string)
}

function collectClaudeBackgroundWork(rawMessages: RawMsg[]): ClaudeBackgroundWork {
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

/**
 * Derive session status from raw JSONL message objects.
 *
 * **Provider dispatch:** The function auto-detects the session format by
 * inspecting `rawMessages[0].type`. Codex sessions start with one of
 * `session_meta | turn_context | event_msg | response_item` and are routed
 * to `deriveCodexSessionStatus`. All other sessions are treated as Claude Code
 * format. If a third provider is added, add a detection branch here and in
 * `src/lib/providers/registry.ts`.
 */
export function deriveSessionStatus(rawMessages: RawMsg[]): SessionStatusInfo {
  const firstType = rawMessages[0]?.type
  if (firstType === "session_meta" || firstType === "turn_context" || firstType === "event_msg" || firstType === "response_item") {
    return deriveCodexSessionStatus(rawMessages)
  }

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

// ── Background-agent signals (Codex collab) ─────────────────────────────────
//
// Codex collaboration agents are spawned with spawn_agent, tracked through
// sub_agent_activity events, and finish via wait_agent results, FINAL_ANSWER
// inter-agent messages, or interruption. A task_complete with spawned agents
// still running means the session is waiting on agents, not on the user.
// This mirrors the lifecycle rules in codex.ts's full parser, reduced to
// alive/done bookkeeping.

const TERMINAL_INTER_AGENT_TYPES = new Set(["FINAL_ANSWER", "ERROR", "FAILED", "INTERRUPTED"])

function codexPayloadText(payload: Record<string, unknown>): string {
  const content = payload.content
  if (!Array.isArray(content)) return ""
  return content
    .filter((block): block is Record<string, unknown> => isObject(block) && block.type === "input_text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null
  try {
    const parsed = JSON.parse(value) as unknown
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function collectCodexPendingAgents(rawMessages: RawMsg[]): string[] {
  const alive = new Map<string, string>() // agentId → description
  const done = new Set<string>()
  const agentIdByPath = new Map<string, string>()
  const spawnCalls = new Map<string, string>() // call_id → task name
  const waitCalls = new Set<string>()
  const interruptCalls = new Map<string, string[]>() // call_id → target agent ids

  function markAlive(agentId: string, description: string) {
    if (!done.has(agentId)) alive.set(agentId, alive.get(agentId) || description)
  }

  for (const msg of rawMessages) {
    const payload = isObject(msg.payload) ? msg.payload : null
    if (!payload) continue

    if (msg.type === "event_msg" && payload.type === "sub_agent_activity"
      && typeof payload.agent_thread_id === "string" && typeof payload.agent_path === "string") {
      const agentId = payload.agent_thread_id
      const kind = typeof payload.kind === "string" ? payload.kind : "started"
      const eventId = typeof payload.event_id === "string" ? payload.event_id : ""
      const existingId = agentIdByPath.get(payload.agent_path)
      const known = alive.has(agentId) || done.has(agentId) || existingId !== undefined || spawnCalls.has(eventId)
      // Only a `started` event (or a previously known agent) establishes a child.
      if (kind !== "started" && !known) continue

      // Agent-id renumbering: a provisional id from the spawn output is
      // superseded by the thread id once activity events arrive.
      if (existingId && existingId !== agentId) {
        if (alive.has(existingId)) {
          markAlive(agentId, alive.get(existingId) ?? "")
          alive.delete(existingId)
        }
        if (done.has(existingId)) done.add(agentId)
      }
      agentIdByPath.set(payload.agent_path, agentId)

      if (kind === "interrupted") {
        done.add(agentId)
        alive.delete(agentId)
      } else {
        markAlive(agentId, spawnCalls.get(eventId) ?? "")
      }
      continue
    }

    if (msg.type !== "response_item") continue

    if (payload.type === "function_call" && typeof payload.call_id === "string") {
      const name = normalizeFunctionName(typeof payload.name === "string" ? payload.name : "")
      if (name === "spawn_agent") {
        const input = parseJsonObject(payload.arguments)
        spawnCalls.set(payload.call_id, typeof input?.task_name === "string" ? input.task_name : "")
      } else if (name === "wait_agent") {
        waitCalls.add(payload.call_id)
      } else if (name === "interrupt_agent") {
        const input = parseJsonObject(payload.arguments)
        const targets = [input?.agent_id, ...(Array.isArray(input?.agent_ids) ? input.agent_ids : [])]
          .filter((id): id is string => typeof id === "string")
        interruptCalls.set(payload.call_id, targets)
      }
      continue
    }

    if (payload.type === "function_call_output" && typeof payload.call_id === "string") {
      const callId = payload.call_id
      if (spawnCalls.has(callId)) {
        const output = parseJsonObject(payload.output)
        const agentId = typeof output?.agent_id === "string" ? output.agent_id : ""
        if (agentId) {
          markAlive(agentId, spawnCalls.get(callId) ?? "")
          const agentPath = typeof output?.task_name === "string" ? output.task_name : ""
          if (agentPath && !agentIdByPath.has(agentPath)) agentIdByPath.set(agentPath, agentId)
        }
      } else if (waitCalls.has(callId)) {
        const output = parseJsonObject(payload.output)
        const statusMap = isObject(output?.status) ? output.status : {}
        for (const [agentId, status] of Object.entries(statusMap)) {
          const statusValue = isObject(status) ? status : {}
          const lifecycle = typeof statusValue.status === "string" ? statusValue.status : ""
          const isTerminal = typeof statusValue.completed === "string"
            || typeof statusValue.failed === "string"
            || typeof statusValue.error === "string"
            || typeof statusValue.interrupted === "string"
            || lifecycle === "completed" || lifecycle === "failed" || lifecycle === "interrupted"
          if (isTerminal) {
            done.add(agentId)
            alive.delete(agentId)
          }
        }
      } else if (interruptCalls.has(callId)) {
        for (const agentId of interruptCalls.get(callId) ?? []) {
          done.add(agentId)
          alive.delete(agentId)
        }
      }
      continue
    }

    if (payload.type === "agent_message" && typeof payload.author === "string") {
      const text = codexPayloadText(payload)
      const messageType = text.match(/^Message Type:\s*([^\r\n]+)/)?.[1]?.trim().toUpperCase() ?? ""
      if (!TERMINAL_INTER_AGENT_TYPES.has(messageType)) continue
      const agentId = agentIdByPath.get(payload.author) ?? payload.author
      done.add(agentId)
      alive.delete(agentId)
    }
  }

  return [...alive.entries()]
    .filter(([agentId]) => !done.has(agentId))
    .map(([, description]) => description)
}

function deriveCodexSessionStatus(rawMessages: RawMsg[]): SessionStatusInfo {
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const msg = rawMessages[i]

    if (msg.type === "event_msg") {
      const payload = msg.payload as { type?: string; message?: string } | undefined
      switch (payload?.type) {
        case "task_complete": {
          // The turn ended, but spawned collab agents may still be running.
          const pending = collectCodexPendingAgents(rawMessages)
          if (pending.length > 0) return awaitingAgentsResult(pending, 0)
          return { status: "completed" }
        }
        case "task_started":
          return { status: "processing" }
        case "agent_message":
          return { status: "thinking" }
        case "token_count":
          continue
      }
    }

    if (msg.type === "response_item") {
      const payload = msg.payload as { type?: string; name?: string; role?: string } | undefined
      if (!payload) continue

      if (payload.type === "function_call") {
        return { status: "tool_use", toolName: payload.name ? normalizeFunctionName(payload.name) : payload.name }
      }
      if (payload.type === "message") {
        if (payload.role === "assistant") return { status: "thinking" }
        if (payload.role === "user") return { status: "processing" }
      }
    }
  }

  return { status: "idle" }
}

/** Tools that indicate the agent is waiting for sub-agents to finish. */
const AGENT_TOOLS = new Set(["Agent", "TaskOutput", "spawn_agent", "wait_agent"])

/** Human-readable label for terminal_reason values from Claude Code. */
export function getTerminalReasonLabel(reason: string): string {
  switch (reason) {
    case "max_turns": return "Stopped — turn limit reached"
    case "aborted_tools": return "Stopped — tools aborted"
    case "blocking_limit": return "Stopped — blocked"
    default: return `Stopped — ${reason.replace(/_/g, " ")}`
  }
}

/** Human-readable label for a session status. Returns null for "idle". */
export function getStatusLabel(
  status: SessionStatus | undefined,
  toolName?: string,
  terminalReason?: string,
  pendingAgents?: number,
): string | null {
  switch (status) {
    case "thinking": return "Thinking..."
    case "tool_use":
      if (toolName && AGENT_TOOLS.has(toolName)) return "Running agents..."
      return toolName ? `Using ${toolName}` : "Using tool..."
    case "processing": return "Processing..."
    case "compacting": return "Compressing context..."
    case "deferred": return "Awaiting permission review"
    case "awaiting_agents":
      if (pendingAgents && pendingAgents > 0) {
        return `Waiting on ${pendingAgents} agent${pendingAgents === 1 ? "" : "s"}...`
      }
      return "Waiting on agents..."
    case "completed":
      if (terminalReason) return getTerminalReasonLabel(terminalReason)
      return "Done"
    default: return null
  }
}

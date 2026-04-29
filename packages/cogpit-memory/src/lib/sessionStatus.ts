/**
 * Derives the current session status from raw JSONL messages.
 * Walks backward from the last message to determine if the agent
 * is idle, thinking, calling tools, etc.
 *
 * This is a pure function — status is always derived from data,
 * never stored as app state.
 */

export type SessionStatus = "idle" | "thinking" | "tool_use" | "processing" | "completed" | "compacting"

export interface SessionStatusInfo {
  status: SessionStatus
  /** Name of the tool currently being used (if status is tool_use) */
  toolName?: string
  /** Number of pending queue items (user messages waiting to be processed) */
  pendingQueue?: number
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
export function deriveSessionStatus(
  rawMessages: Array<{ type: string; [key: string]: unknown }>
): SessionStatusInfo {
  const firstType = rawMessages[0]?.type
  if (firstType === "session_meta" || firstType === "turn_context" || firstType === "event_msg" || firstType === "response_item") {
    return deriveCodexSessionStatus(rawMessages)
  }

  let pendingEnqueues = 0

  /** Build a status result with the current pending queue count. */
  function result(status: SessionStatus, toolName?: string): SessionStatusInfo {
    const info: SessionStatusInfo = { status, pendingQueue: Math.max(0, pendingEnqueues) }
    if (toolName) info.toolName = toolName
    return info
  }

  // Walk backward to find the last meaningful signal
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const msg = rawMessages[i]

    // Track queue state
    if (msg.type === "queue-operation") {
      const op = (msg as { operation?: string }).operation
      if (op === "enqueue") pendingEnqueues++
      else if (op === "dequeue" || op === "remove") pendingEnqueues--
      continue
    }

    if (msg.type === "assistant") {
      const message = msg.message as { stop_reason?: string | null; content?: Array<{ type: string; name?: string }> } | undefined
      const stopReason = message?.stop_reason

      if (stopReason === "end_turn") {
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

    // Compaction markers — skip past them to find the real session state.
    // In-progress compaction is detected live via subagent file watcher (isCompacting),
    // so these finished-compaction markers should not lock the status to "compacting".
    if (msg.type === "summary") continue
    if (msg.type === "system" && (msg as { subtype?: string }).subtype === "compact_boundary") continue

    // Skip progress, system, etc.
  }

  return { status: "idle" }
}

function deriveCodexSessionStatus(
  rawMessages: Array<{ type: string; [key: string]: unknown }>
): SessionStatusInfo {
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const msg = rawMessages[i]

    if (msg.type === "event_msg") {
      const payload = msg.payload as { type?: string; message?: string } | undefined
      switch (payload?.type) {
        case "task_complete":
          return { status: "completed" }
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
        return { status: "tool_use", toolName: payload.name }
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
const AGENT_TOOLS = new Set(["Agent", "TaskOutput"])

/** Human-readable label for a session status. Returns null for "idle". */
export function getStatusLabel(status: SessionStatus | undefined, toolName?: string): string | null {
  switch (status) {
    case "thinking": return "Thinking..."
    case "tool_use":
      if (toolName && AGENT_TOOLS.has(toolName)) return "Running agents..."
      return toolName ? `Using ${toolName}` : "Using tool..."
    case "processing": return "Processing..."
    case "compacting": return "Compressing context..."
    case "completed": return "Done"
    default: return null
  }
}

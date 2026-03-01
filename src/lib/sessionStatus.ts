/**
 * Derives the current session status from raw JSONL messages.
 * Walks backward from the last message to determine if the agent
 * is idle, thinking, calling tools, etc.
 *
 * This is a pure function — status is always derived from data,
 * never stored as app state.
 */

export type SessionStatus = "idle" | "thinking" | "tool_use" | "processing" | "completed"

export interface SessionStatusInfo {
  status: SessionStatus
  /** Name of the tool currently being used (if status is tool_use) */
  toolName?: string
  /** Number of pending queue items (user messages waiting to be processed) */
  pendingQueue?: number
}

/**
 * Derive session status from raw JSONL message objects.
 * Walks backward through messages to find the most recent meaningful signal.
 */
export function deriveSessionStatus(
  rawMessages: Array<{ type: string; [key: string]: unknown }>
): SessionStatusInfo {
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

    // Skip progress, system, summary, etc.
  }

  return { status: "idle" }
}

/** Human-readable label for a session status. Returns null for "idle". */
export function getStatusLabel(status: SessionStatus | undefined, toolName?: string): string | null {
  switch (status) {
    case "thinking": return "Thinking..."
    case "tool_use": return toolName ? `Using ${toolName}` : "Using tool..."
    case "processing": return "Processing..."
    case "completed": return "Done"
    default: return null
  }
}

/**
 * Derive session status from raw JSONL text (for server-side use).
 * Only parses the last few lines for efficiency.
 */
export function deriveSessionStatusFromTail(tailText: string): SessionStatusInfo {
  const lines = tailText.split("\n").filter(Boolean)
  const messages: Array<{ type: string; [key: string]: unknown }> = []
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line))
    } catch {
      // skip malformed
    }
  }
  return deriveSessionStatus(messages)
}

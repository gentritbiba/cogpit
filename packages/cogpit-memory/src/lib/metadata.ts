import { readFile, stat, open } from "node:fs/promises"
import { deriveSessionStatus, type SessionStatusInfo } from "./sessionStatus"
import { extractCodexMetadataFromLines } from "./codex"

// ── Session metadata extraction ─────────────────────────────────────

export async function getSessionMeta(filePath: string) {
  let lines: string[]
  let isPartialRead = false
  const fileStat = await stat(filePath)

  if (fileStat.size > 65536) {
    const fh = await open(filePath, "r")
    try {
      const buf = Buffer.alloc(32768)
      const { bytesRead } = await fh.read(buf, 0, 32768, 0)
      const text = buf.subarray(0, bytesRead).toString("utf-8")
      const lastNewline = text.lastIndexOf("\n")
      lines = (lastNewline > 0 ? text.slice(0, lastNewline) : text).split("\n").filter(Boolean)
      isPartialRead = true
    } finally {
      await fh.close()
    }
  } else {
    const content = await readFile(filePath, "utf-8")
    lines = content.split("\n").filter(Boolean)
  }

  let firstParsed: { type?: string } | null = null
  if (lines.length > 0) {
    try {
      firstParsed = JSON.parse(lines[0]) as { type?: string }
    } catch {
      firstParsed = null
    }
  }
  const isCodex = firstParsed?.type === "session_meta" || firstParsed?.type === "turn_context"
  if (isCodex) {
    if (isPartialRead) {
      const content = await readFile(filePath, "utf-8")
      lines = content.split("\n").filter(Boolean)
    }
    const meta = extractCodexMetadataFromLines(lines)
    return {
      sessionId: meta.sessionId,
      version: meta.version,
      gitBranch: meta.gitBranch,
      model: meta.model,
      slug: meta.slug,
      cwd: meta.cwd,
      firstUserMessage: meta.firstUserMessage,
      lastUserMessage: meta.lastUserMessage,
      timestamp: meta.timestamp,
      turnCount: meta.turnCount,
      lineCount: lines.length,
      branchedFrom: meta.branchedFrom,
    }
  }

  let sessionId = ""
  let version = ""
  let gitBranch = ""
  let model = ""
  let slug = ""
  let cwd = ""
  let firstUserMessage = ""
  let lastUserMessage = ""
  let timestamp = ""
  let turnCount = 0
  let branchedFrom: { sessionId: string; turnIndex?: number | null } | undefined

  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj.sessionId && !sessionId) sessionId = obj.sessionId
      if (obj.version && !version) version = obj.version
      if (obj.gitBranch && !gitBranch) gitBranch = obj.gitBranch
      if (obj.slug && !slug) slug = obj.slug
      if (obj.cwd && !cwd) cwd = obj.cwd
      if (obj.branchedFrom && !branchedFrom) branchedFrom = obj.branchedFrom
      if (obj.type === "assistant" && obj.message?.model && !model) {
        model = obj.message.model
      }
      if (obj.type === "user" && !obj.isMeta && !timestamp) {
        timestamp = obj.timestamp || ""
      }
      if (obj.type === "user" && !obj.isMeta) {
        const c = obj.message?.content
        let extracted = ""
        if (typeof c === "string") {
          const cleaned = c.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim()
          if (cleaned && cleaned.length > 5) extracted = cleaned.slice(0, 120)
        } else if (Array.isArray(c)) {
          for (const block of c) {
            if (block.type === "text") {
              const cleaned = block.text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim()
              if (cleaned && cleaned.length > 5) {
                extracted = cleaned.slice(0, 120)
                break
              }
            }
          }
        }
        if (extracted) {
          if (!firstUserMessage) firstUserMessage = extracted
          lastUserMessage = extracted
        }
        turnCount++
      }
    } catch {
      // skip malformed
    }
  }

  return {
    sessionId,
    version,
    gitBranch,
    model,
    slug,
    cwd,
    firstUserMessage,
    lastUserMessage,
    timestamp,
    turnCount,
    lineCount: isPartialRead ? Math.round(fileStat.size / (32768 / lines.length)) : lines.length,
    branchedFrom,
  }
}

/**
 * Read backward through a session JSONL to derive agent status.
 * Scans in 4KB chunks from the tail, parsing one line at a time until it
 * finds a meaningful message (assistant or non-meta user). This reads only
 * as far as needed — typically one chunk — and uses the same
 * deriveSessionStatus() function as the client side.
 */
export async function getSessionStatus(filePath: string): Promise<SessionStatusInfo> {
  const CHUNK = 4096
  const MAX_CHUNKS = 64 // safety cap: 256KB max scan
  try {
    const fileStat = await stat(filePath)
    if (fileStat.size === 0) return { status: "idle" }

    const fh = await open(filePath, "r")
    try {
      const meaningful: Array<{ type: string; [key: string]: unknown }> = []
      let cursor = fileStat.size
      let leftover = ""

      for (let chunk = 0; chunk < MAX_CHUNKS && cursor > 0; chunk++) {
        const readSize = Math.min(CHUNK, cursor)
        cursor -= readSize
        const buf = Buffer.alloc(readSize)
        const { bytesRead } = await fh.read(buf, 0, readSize, cursor)
        const text = buf.subarray(0, bytesRead).toString("utf-8") + leftover

        // Split into lines, rightmost first
        const lines = text.split("\n")
        // First element may be partial if we didn't hit offset 0
        leftover = cursor > 0 ? lines[0] : ""
        const startIdx = cursor > 0 ? 1 : 0

        for (let i = lines.length - 1; i >= startIdx; i--) {
          const line = lines[i]
          if (!line) continue
          let obj: { type: string; [key: string]: unknown }
          try { obj = JSON.parse(line) } catch { continue }

          if (obj.type === "event_msg") {
            const payload = obj.payload as { type?: string } | undefined
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

          if (obj.type === "response_item") {
            const payload = obj.payload as { type?: string; name?: string } | undefined
            if (payload?.type === "function_call") {
              return { status: "tool_use", toolName: payload.name }
            }
            if (payload?.type === "message") {
              const role = (payload as { role?: string }).role
              if (role === "assistant") return { status: "thinking" }
              if (role === "user") return { status: "processing" }
            }
          }

          if (obj.type === "assistant" || obj.type === "user" || obj.type === "queue-operation") {
            // Prepend so array stays in file order (oldest first)
            meaningful.unshift(obj)

            // Can we derive status from what we've collected?
            // end_turn needs user context to distinguish completed vs idle, so keep scanning.
            const isEndTurn = obj.type === "assistant"
              && (obj.message as { stop_reason?: string } | undefined)?.stop_reason === "end_turn"
            const canDerive = (obj.type === "assistant" && !isEndTurn)
              || (obj.type === "user" && !(obj as { isMeta?: boolean }).isMeta)
            if (canDerive) return deriveSessionStatus(meaningful)
          }
        }
      }

      // Exhausted chunks — derive from whatever we collected
      return meaningful.length > 0 ? deriveSessionStatus(meaningful) : { status: "idle" }
    } finally {
      await fh.close()
    }
  } catch {
    return { status: "idle" }
  }
}

/**
 * Search all user messages in a session file for a query string.
 * Returns the first matching message snippet, or null if no match.
 */
export async function searchSessionMessages(
  filePath: string,
  query: string
): Promise<string | null> {
  const q = query.toLowerCase()

  let content: string
  try {
    content = await readFile(filePath, "utf-8")
  } catch {
    return null
  }

  const lines = content.split("\n")
  for (const line of lines) {
    if (line.includes('"event_msg"') || line.includes('"response_item"')) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === "event_msg" && obj.payload?.type === "user_message" && typeof obj.payload.message === "string") {
          const text = obj.payload.message.trim()
          const lower = text.toLowerCase()
          if (lower.includes(q)) {
            const idx = lower.indexOf(q)
            const start = Math.max(0, idx - 30)
            const end = Math.min(text.length, idx + query.length + 70)
            const snippet = (start > 0 ? "..." : "") + text.slice(start, end).trim() + (end < text.length ? "..." : "")
            return snippet.slice(0, 150)
          }
        }
      } catch {
        // skip malformed
      }
    }

    // Fast pre-check: skip lines that can't be user messages
    if (!line || !line.includes('"user"')) continue
    try {
      const obj = JSON.parse(line)
      if (obj.type !== "user" || obj.isMeta) continue

      const c = obj.message?.content
      let text = ""
      if (typeof c === "string") {
        text = c.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim()
      } else if (Array.isArray(c)) {
        for (const block of c) {
          if (block.type === "text") {
            text += block.text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim() + " "
          }
        }
        text = text.trim()
      }

      const lower = text.toLowerCase()
      if (lower.includes(q)) {
        const idx = lower.indexOf(q)
        const start = Math.max(0, idx - 30)
        const end = Math.min(text.length, idx + query.length + 70)
        const snippet = (start > 0 ? "..." : "") + text.slice(start, end).trim() + (end < text.length ? "..." : "")
        return snippet.slice(0, 150)
      }
    } catch {
      // skip malformed
    }
  }

  return null
}

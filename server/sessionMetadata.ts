import { readFile, stat, open } from "node:fs/promises"
import { deriveSessionStatus, type SessionStatusInfo } from "../src/lib/sessionStatus"
import { extractCodexMetadataFromLines } from "../src/lib/codex"

// ── Session metadata extraction ─────────────────────────────────────

const SKIP_RE = /^(Tool loaded\.?|Continue|compact)$/i

/** Extract meaningful user prompt text from a parsed user message object. */
function extractUserText(obj: { message?: { content?: unknown } }): string {
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
  if (extracted && SKIP_RE.test(extracted)) return ""
  return extracted
}

export async function getSessionMeta(filePath: string) {
  let lines: string[]
  let isPartialRead = false
  const fileStat = await stat(filePath)

  if (fileStat.size > 65536) {
    const fh = await open(filePath, "r")
    try {
      // Read head for session metadata + firstUserMessage
      const headBuf = Buffer.alloc(32768)
      const { bytesRead: headRead } = await fh.read(headBuf, 0, 32768, 0)
      const headText = headBuf.subarray(0, headRead).toString("utf-8")
      const headLastNl = headText.lastIndexOf("\n")
      lines = (headLastNl > 0 ? headText.slice(0, headLastNl) : headText).split("\n").filter(Boolean)
      isPartialRead = true
    } finally {
      await fh.close()
    }
  } else {
    const content = await readFile(filePath, "utf-8")
    lines = content.split("\n").filter(Boolean)
  }

  let firstParsed: { type?: string; payload?: unknown } | null = null
  if (lines.length > 0) {
    try {
      firstParsed = JSON.parse(lines[0]) as { type?: string; payload?: unknown }
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
      lastTimestamp: meta.lastTimestamp,
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
  let lastTimestamp = ""
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
        if (obj.timestamp) lastTimestamp = obj.timestamp
        const extracted = extractUserText(obj)
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

  // For large files the head read misses recent messages (especially image
  // messages whose JSONL lines are megabytes of base64). Scan backward
  // through small chunks — unparseable image lines are skipped, and we pick
  // the most recent parseable user prompt.
  if (isPartialRead) {
    const CHUNK = 4096
    const MAX_CHUNKS = 128 // 512KB max scan
    const fh = await open(filePath, "r")
    try {
      let cursor = fileStat.size
      let leftover = ""
      let foundMessage = false
      let foundTimestamp = false
      outer: for (let i = 0; i < MAX_CHUNKS && cursor > 0; i++) {
        const readSize = Math.min(CHUNK, cursor)
        cursor -= readSize
        const buf = Buffer.alloc(readSize)
        const { bytesRead } = await fh.read(buf, 0, readSize, cursor)
        const text = buf.subarray(0, bytesRead).toString("utf-8") + leftover
        const splitLines = text.split("\n")
        leftover = cursor > 0 ? splitLines[0] : ""
        const startIdx = cursor > 0 ? 1 : 0
        for (let j = splitLines.length - 1; j >= startIdx; j--) {
          const line = splitLines[j]
          if (!line || !line.includes('"user"')) continue
          try {
            const obj = JSON.parse(line)
            if (obj.type !== "user" || obj.isMeta) continue
            // Capture the timestamp from the most recent user message
            if (!foundTimestamp && obj.timestamp) {
              lastTimestamp = obj.timestamp
              foundTimestamp = true
            }
            if (!foundMessage) {
              const extracted = extractUserText(obj)
              if (extracted) {
                lastUserMessage = extracted
                foundMessage = true
              }
            }
            if (foundMessage && foundTimestamp) break outer
          } catch { continue }
        }
      }
    } finally {
      await fh.close()
    }
  }

  // Also backfill lastUserMessage for small files that only had image prompts
  if (!lastUserMessage && firstUserMessage) lastUserMessage = firstUserMessage

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
    lastTimestamp: lastTimestamp || timestamp,
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

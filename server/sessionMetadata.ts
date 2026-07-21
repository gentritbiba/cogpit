import { readFile, stat, open } from "node:fs/promises"
import { deriveSessionStatus, type SessionStatusInfo } from "../shared/session/sessionStatus"
import { extractCodexMetadataFromLines } from "../shared/session/codex"

// ── Session metadata extraction ─────────────────────────────────────

const SKIP_RE = /^(Tool loaded\.?|Continue|compact)$/i
const CODEX_IDENTITY_BYTES = 32768

export interface CodexSessionIdentity {
  sessionId: string
  cwd: string
  gitBranch: string
  isSubagent: boolean
  parentSessionId: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Read only the small header needed to place a Codex rollout in the session
 * inventory. Rich metadata is loaded after routes select the rows they return.
 */
export async function getCodexSessionIdentity(filePath: string): Promise<CodexSessionIdentity | null> {
  const fh = await open(filePath, "r")
  try {
    const buf = Buffer.allocUnsafe(CODEX_IDENTITY_BYTES)
    const { bytesRead } = await fh.read(buf, 0, CODEX_IDENTITY_BYTES, 0)
    const text = buf.subarray(0, bytesRead).toString("utf-8")
    const lastNewline = text.lastIndexOf("\n")
    const completeText = bytesRead === CODEX_IDENTITY_BYTES && lastNewline >= 0
      ? text.slice(0, lastNewline)
      : text

    let sessionId = ""
    let cwd = ""
    let gitBranch = ""
    let isSubagent = false
    let parentSessionId: string | null = null
    let sawSessionMeta = false

    for (const line of completeText.split("\n")) {
      if (!line) continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(record) || !isRecord(record.payload)) continue

      if (record.type === "session_meta") {
        sawSessionMeta = true
        const payload = record.payload
        if (!sessionId && typeof payload.id === "string") sessionId = payload.id
        if (!cwd && typeof payload.cwd === "string") cwd = payload.cwd
        if (!parentSessionId && typeof payload.forked_from_id === "string") {
          parentSessionId = payload.forked_from_id || null
        }
        const source = isRecord(payload.source) ? payload.source : null
        if (source && isRecord(source.subagent)) isSubagent = true
        const git = isRecord(payload.git) ? payload.git : null
        if (!gitBranch && git && typeof git.branch === "string") gitBranch = git.branch
      } else if (record.type === "turn_context") {
        if (!cwd && typeof record.payload.cwd === "string") cwd = record.payload.cwd
      }
    }

    if (!sawSessionMeta || !cwd) return null
    return { sessionId, cwd, gitBranch, isSubagent, parentSessionId }
  } finally {
    await fh.close()
  }
}

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
    return { ...meta, lineCount: lines.length, teamName: "", agentName: "" }
  }

  let sessionId = ""
  let version = ""
  let gitBranch = ""
  let model = ""
  let slug = ""
  let name = ""
  let cwd = ""
  let firstUserMessage = ""
  let lastUserMessage = ""
  let timestamp = ""
  let lastTimestamp = ""
  let turnCount = 0
  let aiTitle = ""
  let branchedFrom: { sessionId: string; turnIndex?: number | null } | undefined
  // Agent-team identity: teammate sessions (CC 2.1.19x+) tag their lines
  // with the team they belong to and their member name within it
  let teamName = ""
  let agentName = ""

  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj.sessionId && !sessionId) sessionId = obj.sessionId
      if (typeof obj.teamName === "string" && obj.teamName && !teamName) teamName = obj.teamName
      if (typeof obj.agentName === "string" && obj.agentName && !agentName) agentName = obj.agentName
      // Claude Code v2.1.1xx+ writes AI-generated session titles; last one wins
      if (obj.type === "ai-title" && obj.aiTitle) aiTitle = obj.aiTitle
      if (obj.version && !version) version = obj.version
      if (obj.gitBranch && !gitBranch) gitBranch = obj.gitBranch
      if (obj.slug && !slug) slug = obj.slug
      if (obj.name && !name) name = obj.name
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
      let foundAiTitle = false
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
          if (!line) continue
          // Scanning newest→oldest, so the first ai-title hit is the latest
          if (!foundAiTitle && line.includes('"ai-title"')) {
            try {
              const obj = JSON.parse(line)
              if (obj.type === "ai-title" && obj.aiTitle) {
                aiTitle = obj.aiTitle
                foundAiTitle = true
              }
            } catch { /* skip */ }
            continue
          }
          if (!line.includes('"user"')) continue
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
            if (foundMessage && foundTimestamp && foundAiTitle) break outer
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
    name,
    aiTitle,
    cwd,
    firstUserMessage,
    lastUserMessage,
    timestamp,
    lastTimestamp: lastTimestamp || timestamp,
    turnCount,
    lineCount: isPartialRead ? Math.round(fileStat.size / (32768 / lines.length)) : lines.length,
    branchedFrom,
    teamName,
    agentName,
    isSubagent: false,
    parentSessionId: null,
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

          // terminal_reason system message — session ended abnormally
          if (obj.type === "system" && (obj as { subtype?: string }).subtype === "terminal_reason") {
            const reason = (obj as { reason?: string }).reason
            if (reason) return { status: "completed", terminalReason: reason }
          }

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

          // Deferred hook_progress — prepend and return immediately
          if (obj.type === "progress") {
            const data = (obj as { data?: { type?: string; decision?: string; hookSpecificOutput?: { permissionDecision?: string } } }).data
            if (data?.type === "hook_progress") {
              const decision = data.decision ?? data.hookSpecificOutput?.permissionDecision
              if (decision === "defer") {
                meaningful.unshift(obj)
                return deriveSessionStatus(meaningful)
              }
            }
            // Non-deferred progress — not meaningful for status, skip
            continue
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

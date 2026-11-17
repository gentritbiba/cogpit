import { readFile, stat, open } from "node:fs/promises"
import { formatForText, isAnyAgentNoiseLine, type AgentFormat, type AgentSessionMetadata } from "./agents"
import { isCompressedTranscript, openTranscript, readTranscriptText } from "./transcriptFile"
import { deriveSessionStatus, type SessionStatusInfo } from "./sessionStatus"
import { storeForPath } from "./stores"
import { instanceSessionId } from "./instances"

/** Files larger than this are read from the head only. */
const FULL_READ_LIMIT = 65536
const HEAD_READ_BYTES = 32768

/** Conversation-level fields, which not every format reports from its header. */
interface ConversationMeta {
  firstUserMessage: string
  lastUserMessage: string
  timestamp: string
  turnCount: number
}

/**
 * What a format's own header scan returns. The Codex and Copilot formats report
 * the conversation fields alongside the identity ones; the Claude format
 * reports identity only, so those are filled in by {@link scanClaudeMessages}.
 */
type HeaderMetadata = AgentSessionMetadata & Partial<ConversationMeta>

function readHeader(format: AgentFormat, lines: readonly string[]): HeaderMetadata {
  return format.metadataFromLines(lines) as HeaderMetadata
}

/** How far back a head-only read looks for the latest prompt and model. */
const TAIL_CHUNK_BYTES = 4096
const TAIL_MAX_CHUNKS = 128
/** A model id as raw text: assistant records are too large to survive a chunked read as whole lines. */
const MODEL_RE = /"model":"([^"]+)"/g

/** Strip inline XML-ish wrappers Claude Code injects around real user text. */
function cleanUserText(text: string): string {
  const cleaned = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim()
  return cleaned.length > 5 ? cleaned.slice(0, 120) : ""
}

interface UserRecord {
  type?: string
  isMeta?: boolean
  timestamp?: string
  origin?: { kind?: string } | null
  message?: { content?: unknown }
}

/** A user record someone typed: tool results and task wake-ups are user records too, and open no turn. */
function isPromptRecord(record: UserRecord): boolean {
  if (record.origin?.kind === "task-notification") return false
  const content = record.message?.content
  return !Array.isArray(content) || !content.some((block) => (block as { type?: string } | null)?.type === "tool_result")
}

function promptText(record: UserRecord): string {
  const content = record.message?.content
  if (typeof content === "string") return cleanUserText(content)
  if (!Array.isArray(content)) return ""
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block.type !== "text" || typeof block.text !== "string") continue
    const extracted = cleanUserText(block.text)
    if (extracted) return extracted
  }
  return ""
}

/**
 * Turn count and first/last user message for a transcript whose format does not
 * report them from its header scan.
 */
function scanClaudeMessages(lines: readonly string[]): ConversationMeta {
  const meta: ConversationMeta = {
    firstUserMessage: "",
    lastUserMessage: "",
    timestamp: "",
    turnCount: 0,
  }

  for (const line of lines) {
    if (isAnyAgentNoiseLine(line)) continue
    let record: UserRecord
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.type !== "user" || record.isMeta) continue
    if (!meta.timestamp) meta.timestamp = record.timestamp || ""
    if (!isPromptRecord(record)) continue

    const extracted = promptText(record)
    if (extracted) {
      if (!meta.firstUserMessage) meta.firstUserMessage = extracted
      meta.lastUserMessage = extracted
    }
    meta.turnCount += 1
  }

  return meta
}

/**
 * The latest prompt and model of a transcript read from its head only: both
 * sit near the end, past the head of a session that opens with a large prompt.
 */
async function scanTail(filePath: string, size: number): Promise<{ lastUserMessage: string; model: string }> {
  const found = { lastUserMessage: "", model: "" }
  const handle = await open(filePath, "r")
  try {
    let cursor = size
    let leftover = ""
    for (let chunk = 0; chunk < TAIL_MAX_CHUNKS && cursor > 0 && !(found.lastUserMessage && found.model); chunk++) {
      const length = Math.min(TAIL_CHUNK_BYTES, cursor)
      cursor -= length
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, cursor)
      const text = buffer.subarray(0, bytesRead).toString("utf-8") + leftover
      if (!found.model) {
        for (const match of text.matchAll(MODEL_RE)) if (!match[1].startsWith("<")) found.model = match[1]
      }
      const lines = text.split("\n")
      leftover = cursor > 0 ? lines.shift() ?? "" : ""
      for (let index = lines.length - 1; index >= 0 && !found.lastUserMessage; index--) {
        const line = lines[index]
        if (!line.includes('"user"') || isAnyAgentNoiseLine(line)) continue
        try {
          const record = JSON.parse(line) as UserRecord
          if (record.type === "user" && !record.isMeta && isPromptRecord(record)) found.lastUserMessage = promptText(record)
        } catch { /* a line cut by the chunk edge */ }
      }
    }
  } finally {
    await handle.close()
  }
  return found
}

async function readLines(filePath: string, size: number): Promise<{
  lines: string[]
  isPartialRead: boolean
}> {
  if (size <= FULL_READ_LIMIT || isCompressedTranscript(filePath)) {
    const content = await readTranscriptText(filePath)
    return { lines: content.split("\n").filter(Boolean), isPartialRead: false }
  }

  const handle = await open(filePath, "r")
  try {
    const buffer = Buffer.alloc(HEAD_READ_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_READ_BYTES, 0)
    const text = buffer.subarray(0, bytesRead).toString("utf-8")
    // Drop the trailing partial line rather than letting it fail to parse.
    const lastNewline = text.lastIndexOf("\n")
    return {
      lines: (lastNewline > 0 ? text.slice(0, lastNewline) : text).split("\n").filter(Boolean),
      isPartialRead: true,
    }
  } finally {
    await handle.close()
  }
}

// ── Session metadata extraction ─────────────────────────────────────

/**
 * Header metadata for one transcript, whichever agent wrote it.
 *
 * Which agent that is comes from the shared format registry, in its own
 * detection order — the same code the app and the parser use, rather than a
 * hand-rolled sniff that recognised a narrower set of Codex records.
 */
export async function getSessionMeta(filePath: string) {
  const fileStat = await stat(filePath)
  let { lines, isPartialRead } = await readLines(filePath, fileStat.size)

  const format = formatForText(lines.join("\n"))

  // A format whose header scan cannot report a turn count or the last user
  // message has to see the whole file, so a partial read is a false economy.
  if (isPartialRead && !format.descriptor.metadataFromHead) {
    lines = (await readFile(filePath, "utf-8")).split("\n").filter(Boolean)
    isPartialRead = false
  }

  const header = readHeader(format, lines)
  const instanceId = storeForPath(filePath)?.instanceId ?? "default"
  const scanned = header.turnCount === undefined
  const conversation: ConversationMeta = header.turnCount === undefined
    ? scanClaudeMessages(lines)
    : {
        firstUserMessage: header.firstUserMessage ?? "",
        lastUserMessage: header.lastUserMessage ?? "",
        timestamp: header.timestamp ?? "",
        turnCount: header.turnCount,
      }

  let model = header.model
  if (scanned && isPartialRead) {
    const tail = await scanTail(filePath, fileStat.size)
    if (tail.lastUserMessage) conversation.lastUserMessage = tail.lastUserMessage
    if (tail.model) model = tail.model
  }

  return {
    sessionId: instanceSessionId(instanceId, header.sessionId),
    version: header.version,
    gitBranch: header.gitBranch,
    model,
    slug: header.slug,
    cwd: header.cwd,
    ...conversation,
    // A head read saw a known number of lines in a known number of bytes;
    // scaling that by the file size is the only estimate available.
    lineCount: isPartialRead
      ? Math.round(fileStat.size / (HEAD_READ_BYTES / lines.length))
      : lines.length,
    branchedFrom: header.branchedFrom ? { ...header.branchedFrom, sessionId: instanceSessionId(instanceId, header.branchedFrom.sessionId) } : undefined,
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
    const fh = await openTranscript(filePath)
    try {
      const fileStat = await fh.stat()
      if (fileStat.size === 0) return { status: "idle" }
      const meaningful: Array<{ type: string; [key: string]: unknown }> = []
      let cursor = fileStat.size
      let leftover = ""
      let copilotTurnEnded = false

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
          if (!line || isAnyAgentNoiseLine(line)) continue
          let obj: { type: string; [key: string]: unknown }
          try { obj = JSON.parse(line) } catch { continue }

          if (
            obj.type.startsWith("subagent.")
            && typeof obj.agentId === "string"
            && obj.agentId.length > 0
          ) {
            meaningful.unshift(obj)
            continue
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

          if (
            obj.type === "abort"
            || obj.type === "user.message"
            || obj.type.startsWith("assistant.")
            || obj.type.startsWith("permission.")
            || obj.type.startsWith("session.")
            || obj.type.startsWith("tool.")
            || obj.type.startsWith("user_input.")
          ) {
            if (typeof obj.agentId === "string" && obj.agentId) continue
            meaningful.unshift(obj)
            if (obj.type === "assistant.turn_end") {
              copilotTurnEnded = true
              continue
            }
            if (copilotTurnEnded && obj.type !== "assistant.message" && obj.type !== "user.message") {
              continue
            }
            const status = deriveSessionStatus(meaningful)
            if (status.status !== "idle") return status
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

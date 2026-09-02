import { readFile, stat, open } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { formatForRecords } from "../shared/session/agents"
import { deriveSessionStatus, type SessionStatusInfo } from "../shared/session/sessionStatus"
import { extractCodexMetadataFromLines } from "../shared/session/codex"
import { extractCopilotMetadataFromLines } from "../shared/session/copilot"
import type { AgentSettingMessage, RawRecord, WorktreeStateMessage } from "../shared/session/types"
import {
  classifyTailRecord,
  type AgentTailFormat,
  type TailMatch,
} from "./agents/tailRecords"

// ── Session metadata extraction ─────────────────────────────────────

const SKIP_RE = /^(Tool loaded\.?|Continue|compact)$/i
const CODEX_IDENTITY_BYTES = 32768
const COPILOT_IDENTITY_BYTES = 32768

const MODEL_RE = /"model":"([^"]+)"/g

/**
 * Newest real model id in a slab of transcript text. Synthetic assistant
 * messages (interrupts, local errors) are tagged "<synthetic>" and would
 * otherwise mask the model that actually ran the turn.
 */
function lastRealModel(text: string): string | null {
  let found: string | null = null
  for (const match of text.matchAll(MODEL_RE)) {
    if (!match[1].startsWith("<")) found = match[1]
  }
  return found
}

export interface CodexSessionIdentity {
  sessionId: string
  cwd: string
  gitBranch: string
  isSubagent: boolean
  parentSessionId: string | null
}

export interface CopilotSessionIdentity {
  sessionId: string
  cwd: string
  gitBranch: string
  isSubagent: false
  parentSessionId: null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseSimpleYamlValue(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) as string } catch { return value.slice(1, -1) }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

async function readCopilotWorkspace(filePath: string): Promise<{ cwd: string; gitBranch: string }> {
  try {
    const workspace = await readFile(join(dirname(filePath), "workspace.yaml"), "utf-8")
    let cwd = ""
    let gitBranch = ""
    for (const line of workspace.split("\n")) {
      const match = line.match(/^\s*(cwd|working_directory|branch)\s*:\s*(.*?)\s*$/)
      if (!match || !match[2]) continue
      const value = parseSimpleYamlValue(match[2])
      if ((match[1] === "cwd" || match[1] === "working_directory") && !cwd) cwd = value
      if (match[1] === "branch" && !gitBranch) gitBranch = value
    }
    return { cwd, gitBranch }
  } catch {
    return { cwd: "", gitBranch: "" }
  }
}

/** Read the small durable header used to place a Copilot session in inventory. */
export async function getCopilotSessionIdentity(filePath: string): Promise<CopilotSessionIdentity | null> {
  const fh = await open(filePath, "r")
  let text = ""
  try {
    const buf = Buffer.allocUnsafe(COPILOT_IDENTITY_BYTES)
    const { bytesRead } = await fh.read(buf, 0, COPILOT_IDENTITY_BYTES, 0)
    text = buf.subarray(0, bytesRead).toString("utf-8")
    if (bytesRead === COPILOT_IDENTITY_BYTES) {
      const lastNewline = text.lastIndexOf("\n")
      if (lastNewline >= 0) text = text.slice(0, lastNewline)
    }
  } finally {
    await fh.close()
  }

  let sessionId = basename(dirname(filePath))
  let cwd = ""
  let gitBranch = ""
  for (const line of text.split("\n")) {
    if (!line) continue
    let record: unknown
    try { record = JSON.parse(line) } catch { continue }
    if (!isRecord(record) || (record.type !== "session.start" && record.type !== "session.resume")) continue
    const data = isRecord(record.data) ? record.data : null
    if (!data) continue
    if (typeof data.sessionId === "string" && data.sessionId) sessionId = data.sessionId
    const context = isRecord(data.context) ? data.context : null
    if (!cwd && context && typeof context.cwd === "string") cwd = context.cwd
    if (!gitBranch && context && typeof context.branch === "string") gitBranch = context.branch
  }

  if (!cwd || !gitBranch) {
    const workspace = await readCopilotWorkspace(filePath)
    cwd ||= workspace.cwd
    gitBranch ||= workspace.gitBranch
  }
  if (!sessionId || !cwd) return null
  return { sessionId, cwd, gitBranch, isSubagent: false, parentSessionId: null }
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

const EFFORT_CHUNK = 65536
const NEWLINE_BYTE = 0x0a

/**
 * Pull the reasoning effort out of a single transcript line.
 *
 * Claude tags every assistant record with the effort that turn ran at; Codex
 * records it per turn, and newer CLI versions moved it under `thread_settings`.
 */
function effortFromLine(line: string): string | null {
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(record)) return null

  if (record.type === "assistant") {
    return typeof record.effort === "string" && record.effort ? record.effort : null
  }

  if (record.type === "turn_context" && isRecord(record.payload)) {
    const { payload } = record
    if (typeof payload.effort === "string" && payload.effort) return payload.effort
    const settings = isRecord(payload.thread_settings) ? payload.thread_settings : null
    const nested = settings?.reasoning_effort
    if (typeof nested === "string" && nested) return nested
  }

  if (
    (record.type === "session.start"
      || record.type === "session.resume"
      || record.type === "session.model_change")
    && isRecord(record.data)
  ) {
    const effort = record.data.reasoningEffort ?? record.data.effort
    return typeof effort === "string" && effort ? effort : null
  }

  return null
}

/**
 * Read the effort a session most recently ran at, scanning newest → oldest.
 *
 * Effort changes mid-session, so only the last record reflects current state.
 * Kept out of getSessionMeta because session listings render that for every row
 * and would pay this scan without using the result. Takes a path rather than a
 * session id because findJsonlPath lives in sessionPaths, which imports this
 * module — resolving here would make the cycle.
 */
export async function readTranscriptEffort(filePath: string): Promise<string | null> {
  let fileStat: Awaited<ReturnType<typeof stat>>
  try {
    fileStat = await stat(filePath)
  } catch {
    return null
  }

  const fh = await open(filePath, "r")
  try {
    let cursor = fileStat.size
    // Held as bytes, not text: a chunk boundary can fall inside a multi-byte
    // character, so only whole lines are ever decoded.
    let leftover = Buffer.alloc(0)

    // No scan cap. Codex writes turn_context once per turn, so a single long
    // turn can push the only effort record megabytes away from the end; any
    // fixed budget silently returns null on exactly those sessions.
    while (cursor > 0) {
      const readSize = Math.min(EFFORT_CHUNK, cursor)
      cursor -= readSize
      const buf = Buffer.alloc(readSize)
      const { bytesRead } = await fh.read(buf, 0, readSize, cursor)
      const chunk = Buffer.concat([buf.subarray(0, bytesRead), leftover])

      const firstNewline = chunk.indexOf(NEWLINE_BYTE)
      if (cursor > 0 && firstNewline === -1) {
        // One line longer than a chunk; keep accumulating toward its start.
        leftover = chunk
        continue
      }
      // Below the first newline is a partial line until we reach the head.
      leftover = cursor > 0 ? chunk.subarray(0, firstNewline) : Buffer.alloc(0)

      const body = cursor > 0 ? chunk.subarray(firstNewline + 1) : chunk
      const lines = body.toString("utf-8").split("\n")
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (!line || (!line.includes("effort") && !line.includes("Effort"))) continue
        const effort = effortFromLine(line)
        if (effort) return effort
      }
    }
  } finally {
    await fh.close()
  }

  return null
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

/**
 * Whether a user record opens a turn, i.e. is a prompt someone typed.
 *
 * Claude Code writes tool results and background-task wake-ups as user records
 * too. Counting those made this disagree wildly with the timeline's own count
 * (56 against 5 on a real session), and since the two are reconciled by taking
 * the larger, the inflated one always won.
 */
function isPromptRecord(obj: {
  origin?: { kind?: string } | null
  message?: { content?: unknown }
}): boolean {
  if (obj.origin?.kind === "task-notification") return false
  const content = obj.message?.content
  if (Array.isArray(content)) {
    return !content.some((block) => block?.type === "tool_result")
  }
  return true
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

  let firstParsed: { type?: unknown } | null = null
  if (lines.length > 0) {
    try {
      firstParsed = JSON.parse(lines[0]) as { type?: unknown }
    } catch {
      firstParsed = null
    }
  }

  // The first record's shape names the agent. Both external formats extract
  // from whole records rather than the head-plus-tail walk Claude uses, so they
  // need the complete file; Claude falls through to the incremental scan below.
  const agentKind = formatForRecords(firstParsed ? [firstParsed] : []).kind
  if (agentKind !== "claude") {
    if (isPartialRead) {
      const content = await readFile(filePath, "utf-8")
      lines = content.split("\n").filter(Boolean)
    }
    if (agentKind === "codex") {
      const meta = extractCodexMetadataFromLines(lines)
      return { ...meta, lineCount: lines.length, teamName: "", agentName: "" }
    }
    const meta = extractCopilotMetadataFromLines(lines)
    return {
      ...meta,
      aiTitle: "",
      customTitle: "",
      lineCount: lines.length,
      teamName: "",
      agentName: "",
    }
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
  let customTitle = ""
  let branchedFrom: { sessionId: string; turnIndex?: number | null } | undefined
  // Agent-team identity: teammate sessions (CC 2.1.19x+) tag their lines
  // with the team they belong to and their member name within it
  let teamName = ""
  let agentName = ""
  // Worktree checkout the session is operating in, when it entered one
  let worktreeName: string | undefined
  let worktreeBranch: string | undefined
  let originalBranch: string | undefined
  // The agent type the session was launched as, e.g. "general-purpose"
  let agentSetting: string | undefined

  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj.sessionId && !sessionId) sessionId = obj.sessionId
      if (typeof obj.teamName === "string" && obj.teamName && !teamName) teamName = obj.teamName
      if (typeof obj.agentName === "string" && obj.agentName && !agentName) agentName = obj.agentName
      // Claude Code v2.1.1xx+ writes AI-generated session titles; last one wins
      if (obj.type === "ai-title" && obj.aiTitle) aiTitle = obj.aiTitle
      // The CLI's own title, seeded from the opening prompt — a label for
      // sessions that never got an ai-title and whose prompts sit past the head read
      if (obj.type === "custom-title" && obj.customTitle) customTitle = obj.customTitle
      // worktree-state records the session's current checkout, so the last
      // one wins and one without a worktreeSession means the session left
      if (obj.type === "worktree-state") {
        const worktree = (obj as WorktreeStateMessage).worktreeSession
        const session = isRecord(worktree) ? worktree : null
        worktreeName = session?.worktreeName
        worktreeBranch = session?.worktreeBranch
        originalBranch = session?.originalBranch
      }
      // The launch agent type never changes mid-session and repeats verbatim, so first wins
      if (obj.type === "agent-setting" && !agentSetting) {
        agentSetting = (obj as AgentSettingMessage).agentSetting || undefined
      }
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
        if (isPromptRecord(obj)) {
          turnCount++
          const extracted = extractUserText(obj)
          if (extracted) {
            if (!firstUserMessage) firstUserMessage = extracted
            lastUserMessage = extracted
          }
        }
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
      let foundModel = !!model
      outer: for (let i = 0; i < MAX_CHUNKS && cursor > 0; i++) {
        const readSize = Math.min(CHUNK, cursor)
        cursor -= readSize
        const buf = Buffer.alloc(readSize)
        const { bytesRead } = await fh.read(buf, 0, readSize, cursor)
        const text = buf.subarray(0, bytesRead).toString("utf-8") + leftover
        // Assistant records are far larger than one chunk, so they almost never
        // survive as parseable lines here — the model is matched as raw text instead.
        if (!foundModel) {
          const found = lastRealModel(text)
          if (found) {
            model = found
            foundModel = true
          }
        }
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
            if (!foundMessage && isPromptRecord(obj)) {
              const extracted = extractUserText(obj)
              if (extracted) {
                lastUserMessage = extracted
                foundMessage = true
              }
            }
            if (foundMessage && foundTimestamp && foundAiTitle && foundModel) break outer
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
    customTitle,
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
    worktreeName,
    worktreeBranch,
    originalBranch,
    agentSetting,
    isSubagent: false,
    parentSessionId: null,
  }
}

/**
 * Read backward through a session JSONL to derive agent status.
 *
 * Scans in 4KB chunks from the tail, parsing one line at a time until it finds
 * a record that settles the verdict. This reads only as far as needed —
 * typically one chunk — and hands the result to the same deriveSessionStatus()
 * the client uses.
 *
 * Two phases. Until a turn-ending line is seen the transcript's agent is
 * unknown, so every tail format gets a look at each record; their record
 * vocabularies are disjoint, so at most one answers. A turn-ending line alone
 * cannot tell "done" from "waiting on background agents", so it names the agent
 * and switches the scan into a filtered phase that keeps reading — up to the
 * cap — but only collects lines that could still change that verdict.
 */
export async function getSessionStatus(filePath: string): Promise<SessionStatusInfo> {
  const CHUNK = 4096
  const MAX_CHUNKS = 64 // safety cap: 256KB max scan
  try {
    const fileStat = await stat(filePath)
    if (fileStat.size === 0) return { status: "idle" }

    const fh = await open(filePath, "r")
    try {
      const meaningful: RawRecord[] = []
      let cursor = fileStat.size
      let leftover = ""
      let turnEnded: AgentTailFormat | null = null
      let needUserActivity = false

      /** Cheap string test that keeps the filtered phase from parsing irrelevant lines. */
      const isTailCandidate = (line: string, format: AgentTailFormat): boolean =>
        format.markers.some((marker) => line.includes(marker))
        || (needUserActivity && line.includes('"type":"user"'))

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
          // Filtered phase: skip lines that cannot change the verdict before
          // paying for a JSON parse.
          if (turnEnded && !isTailCandidate(line, turnEnded)) continue

          let record: RawRecord
          try { record = JSON.parse(line) } catch { continue }
          if (typeof record?.type !== "string") continue

          const match: TailMatch | null = turnEnded
            ? { format: turnEnded, verdict: turnEnded.classifyAfterTurnEnd(record) }
            : classifyTailRecord(record)
          if (!match) continue
          const { verdict } = match

          switch (verdict.kind) {
            case "ignore":
              continue
            case "final":
              return verdict.status
            case "keep":
              meaningful.unshift(record)
              if (verdict.sawUserActivity) needUserActivity = false
              continue
            case "answer":
              meaningful.unshift(record)
              return deriveSessionStatus(meaningful)
            case "answer-if-active": {
              meaningful.unshift(record)
              const status = deriveSessionStatus(meaningful)
              if (status.status !== "idle") return status
              continue
            }
            case "turn-end":
              meaningful.unshift(record)
              turnEnded = match.format
              needUserActivity = verdict.awaitUserActivity === true
              continue
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
    if (line.includes('"user.message"')) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === "user.message" && !(typeof obj.agentId === "string" && obj.agentId)) {
          const text = typeof obj.data?.content === "string" ? obj.data.content.trim() : ""
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

import { open } from "node:fs/promises"
import type { AgentSettingMessage, WorktreeStateMessage } from "../../shared/session/types"
import { isRecord } from "../../shared/objects"
import { HEAD_BYTES } from "./transcriptHead"
import type { SessionMeta, TranscriptHead } from "./types"

/**
 * Claude Code's session metadata: the identity fields come from the head, and
 * for a transcript too large to read whole a backward scan of the tail finds
 * the newest prompt, title and model, which the head cannot know.
 */

const SKIP_RE = /^(Tool loaded\.?|Continue|compact)$/i
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

export async function readClaudeSessionMeta(
  filePath: string,
  head: TranscriptHead,
): Promise<SessionMeta> {
  const { lines, isPartialRead } = head

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
      let cursor = head.size
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
    lineCount: isPartialRead ? Math.round(head.size / (HEAD_BYTES / lines.length)) : lines.length,
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

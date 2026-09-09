import { AGENT_KINDS, type AgentKind } from "../../shared/session/agent-descriptors"
import { isRecord } from "../../shared/objects"

/**
 * Per-agent readers for single transcript records, for the scans in
 * `server/sessionMetadata.ts` that walk a file line by line without knowing
 * which agent wrote it. Their record vocabularies are disjoint, so a record is
 * offered to every reader and at most one answers.
 */

interface AgentRecordReader {
  readonly kind: AgentKind
  /** Reasoning effort a record declares for the turn it belongs to. */
  effort(record: Record<string, unknown>): string | null
  /** Cheap substring test: only a line containing one of these can be a prompt. */
  readonly userMessageMarkers: readonly string[]
  /** Text of a prompt someone typed, or null for any other record. */
  userMessageText(record: Record<string, unknown>): string | null
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

/** Strip `<tag>…</tag>` wrappers Claude Code puts around injected context. */
function stripTaggedBlocks(text: string): string {
  return text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim()
}

const claudeReader: AgentRecordReader = {
  kind: "claude",
  // Every assistant record is tagged with the effort that turn ran at.
  effort: (record) => record.type === "assistant" ? nonEmpty(record.effort) : null,
  userMessageMarkers: ['"user"'],
  userMessageText(record) {
    if (record.type !== "user" || record.isMeta) return null
    const content = isRecord(record.message) ? record.message.content : undefined
    if (typeof content === "string") return stripTaggedBlocks(content)
    if (!Array.isArray(content)) return ""
    let text = ""
    for (const block of content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        text += stripTaggedBlocks(block.text) + " "
      }
    }
    return text.trim()
  },
}

const codexReader: AgentRecordReader = {
  kind: "codex",
  // Effort is recorded per turn; newer CLI versions moved it under `thread_settings`.
  effort(record) {
    if (record.type !== "turn_context" || !isRecord(record.payload)) return null
    const { payload } = record
    const direct = nonEmpty(payload.effort)
    if (direct) return direct
    const settings = isRecord(payload.thread_settings) ? payload.thread_settings : null
    return nonEmpty(settings?.reasoning_effort)
  },
  userMessageMarkers: ['"event_msg"'],
  userMessageText(record) {
    if (record.type !== "event_msg" || !isRecord(record.payload)) return null
    const { payload } = record
    return payload.type === "user_message" && typeof payload.message === "string"
      ? payload.message.trim()
      : null
  },
}

const copilotReader: AgentRecordReader = {
  kind: "copilot",
  effort(record) {
    if (
      (record.type !== "session.start"
        && record.type !== "session.resume"
        && record.type !== "session.model_change")
      || !isRecord(record.data)
    ) return null
    return nonEmpty(record.data.reasoningEffort ?? record.data.effort)
  },
  userMessageMarkers: ['"user.message"'],
  userMessageText(record) {
    if (record.type !== "user.message") return null
    // Sub-agent prompts carry an agentId; only the user's own count.
    if (typeof record.agentId === "string" && record.agentId) return null
    const data = isRecord(record.data) ? record.data : null
    return typeof data?.content === "string" ? data.content.trim() : ""
  },
}

const READERS: Readonly<Record<AgentKind, AgentRecordReader>> = Object.freeze({
  claude: claudeReader,
  codex: codexReader,
  copilot: copilotReader,
})

/** The effort a record declares, whichever agent wrote it. */
export function effortFromRecord(record: Record<string, unknown>): string | null {
  for (const kind of AGENT_KINDS) {
    const effort = READERS[kind].effort(record)
    if (effort) return effort
  }
  return null
}

/**
 * The prompt text on a transcript line, or null when the line is not a user
 * prompt. Malformed lines and lines that cannot be prompts cost no parse.
 */
export function userMessageTextFromLine(line: string): string | null {
  const candidates = AGENT_KINDS.filter((kind) =>
    READERS[kind].userMessageMarkers.some((marker) => line.includes(marker)),
  )
  if (candidates.length === 0) return null
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(record)) return null
  for (const kind of candidates) {
    const text = READERS[kind].userMessageText(record)
    if (text !== null) return text
  }
  return null
}

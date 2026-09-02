import { extractCodexMetadataFromLines } from "../../shared/session/codex"
import { HEAD_BYTES, readHeadLines, readWholeTranscript } from "./transcriptHead"
import type { SessionIdentity, SessionMeta, TranscriptHead } from "./types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Read only the small header needed to place a Codex rollout in the session
 * inventory. Rich metadata is loaded after routes select the rows they return.
 */
export async function readCodexSessionIdentity(filePath: string): Promise<SessionIdentity | null> {
  let sessionId = ""
  let cwd = ""
  let gitBranch = ""
  let isSubagent = false
  let parentSessionId: string | null = null
  let sawSessionMeta = false

  for (const line of await readHeadLines(filePath, HEAD_BYTES)) {
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
}

/**
 * A rollout's header carries no turn count and no last prompt — both only
 * settle at the end of the file — so the whole transcript is read.
 */
export async function readCodexSessionMeta(
  filePath: string,
  head: TranscriptHead,
): Promise<SessionMeta> {
  const lines = await readWholeTranscript(filePath, head)
  const meta = extractCodexMetadataFromLines(lines)
  return {
    ...meta,
    aiTitle: "",
    customTitle: "",
    lineCount: lines.length,
    teamName: "",
    agentName: "",
  }
}

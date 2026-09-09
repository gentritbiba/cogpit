import { readFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { extractCopilotMetadataFromLines } from "../../shared/session/copilot"
import { isRecord } from "../../shared/objects"
import { HEAD_BYTES, readHeadLines, readWholeTranscript } from "./transcriptHead"
import type { SessionIdentity, SessionMeta, TranscriptHead } from "./types"

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

/** The `workspace.yaml` sidecar beside a transcript, for a session whose events omit its cwd. */
async function readWorkspace(filePath: string): Promise<{ cwd: string; gitBranch: string }> {
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
export async function readCopilotSessionIdentity(filePath: string): Promise<SessionIdentity | null> {
  let sessionId = basename(dirname(filePath))
  let cwd = ""
  let gitBranch = ""
  for (const line of await readHeadLines(filePath, HEAD_BYTES)) {
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
    const workspace = await readWorkspace(filePath)
    cwd ||= workspace.cwd
    gitBranch ||= workspace.gitBranch
  }
  if (!sessionId || !cwd) return null
  return { sessionId, cwd, gitBranch, isSubagent: false, parentSessionId: null }
}

/** Metadata is extracted from whole events, so a partial head read is completed first. */
export async function readCopilotSessionMeta(
  filePath: string,
  head: TranscriptHead,
): Promise<SessionMeta> {
  const lines = await readWholeTranscript(filePath, head)
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

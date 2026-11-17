import { open, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { archiveSession, unarchiveSession } from "@anthropic-ai/claude-agent-sdk"
import { isRecord } from "../../shared/objects"
import type { AgentSessionFileCodec } from "../../shared/session/agent-descriptors"
import type { ArchiveMark } from "./types"

/**
 * Claude Code's own session archive: `<project>/<sessionId>/archived.json`,
 * holding `{archived, at, by}`, written by the SDK's `archiveSession` and
 * `unarchiveSession` and by other Claude clients. The CLI counts a human
 * prompt newer than `at` as unarchiving the session without rewriting the
 * file; Cogpit's archive rule reads newer transcript writes the same way.
 */

const MARK_FILE = "archived.json"
/** The SDK ignores a mark larger than this. */
const MAX_MARK_BYTES = 4096

/** Where the mark for the transcript at `filePath` lives, or null when its name carries no session id. */
export function archiveMarkPath(codec: AgentSessionFileCodec, filePath: string): string | null {
  const sessionId = codec.sessionId(basename(filePath))
  return sessionId ? join(dirname(filePath), sessionId, MARK_FILE) : null
}

/** The transcript a mark at `markPath` belongs to, or null when the path is no mark. */
export function archiveMarkTranscript(codec: AgentSessionFileCodec, markPath: string): string | null {
  if (basename(markPath) !== MARK_FILE) return null
  const sessionDir = dirname(markPath)
  return join(dirname(sessionDir), codec.name(basename(sessionDir)))
}

/** The mark at `markPath`, or null when it is missing, too large or malformed. */
export async function readArchiveMark(markPath: string): Promise<ArchiveMark | null> {
  let text: string
  const handle = await open(markPath, "r").catch(() => null)
  if (!handle) return null
  try {
    const buffer = Buffer.alloc(MAX_MARK_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_MARK_BYTES) return null
    text = buffer.toString("utf8", 0, bytesRead)
  } finally {
    await handle.close()
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value.archived !== "boolean" || typeof value.at !== "string") return null
  const atMs = Date.parse(value.at)
  return Number.isFinite(atMs) ? { archived: value.archived, atMs } : null
}

function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path))
}

/**
 * Archive or restore a session through the SDK, which marks every copy of the
 * transcript under the projects directory of the config directory it reads
 * (`CLAUDE_CONFIG_DIR`, else `~/.claude`). Throws for a store rooted
 * elsewhere, such as a provider instance's, and when the SDK finds no copy.
 */
export async function writeArchiveMark(
  root: string,
  codec: AgentSessionFileCodec,
  filePath: string,
  archived: boolean,
): Promise<void> {
  const sessionId = codec.sessionId(basename(filePath))
  if (!sessionId) throw new Error(`${filePath} names no session`)
  const sdkProjects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects")
  if (await canonical(root) !== await canonical(sdkProjects)) {
    throw new Error(`the SDK keeps its archive under ${sdkProjects}, not ${root}`)
  }
  await (archived ? archiveSession(sessionId) : unarchiveSession(sessionId))
}

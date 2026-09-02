import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { descriptorFor } from "../../shared/session/agent-descriptors"
import { isWithinDir } from "../pathSafety"
import { readCodexSessionIdentity, readCodexSessionMeta } from "./codexMetadata"
import { resolveCanonicalFileWithinRoot, statContainedFile } from "./containment"
import { readTranscriptHead } from "./transcriptHead"
import {
  addressFromTranscript,
  projectSessionFilesFromInventory,
  projectsFromInventory,
  topLevelSessionsFromInventory,
} from "./transcriptProjects"
import type { AgentStore, SessionFileInfo, SubagentFileInfo } from "./types"

/**
 * Codex writes one rollout per session into a date-nested tree:
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl`. The project
 * a rollout belongs to appears only inside the file, so listings carry no
 * dirName.
 *
 * The root is captured at module load from the environment, which the test
 * fixtures rely on: they set `CODEX_HOME` before re-importing the module.
 */

const descriptor = descriptorFor("codex")

const HOME_DIR = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"))
const SESSIONS_DIR = join(HOME_DIR, "sessions")

/** The dated tree is `YYYY/MM/DD/<file>`; nothing legitimate sits deeper. */
const MAX_WALK_DEPTH = 4

async function walk(dir: string, depth: number): Promise<SessionFileInfo[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const results: SessionFileInfo[] = []
  for (const entry of entries) {
    const filePath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < MAX_WALK_DEPTH) results.push(...await walk(filePath, depth + 1))
      continue
    }
    if (!entry.name.endsWith(".jsonl")) continue
    const stats = await statContainedFile(SESSIONS_DIR, filePath)
    if (!stats) continue
    results.push({
      filePath,
      // Travels to the client and back as a URL path segment, so it stays
      // forward-slashed regardless of the host separator.
      fileName: relative(SESSIONS_DIR, filePath).split(sep).join("/"),
      dirName: null,
      ...stats,
    })
  }
  return results
}

async function findSessionFile(sessionId: string): Promise<string | null> {
  // The rollout name prefixes the id with a timestamp, so the id is only ever
  // a suffix of the file name — there is no path to compute up front.
  const files = await walk(SESSIONS_DIR, 0)
  return files.find((file) => file.fileName.endsWith(`${sessionId}.jsonl`))?.filePath ?? null
}

export const codexStore: AgentStore = {
  kind: "codex",
  descriptor,

  sessionsRoot: () => SESSIONS_DIR,

  ownsPath(filePath: string): boolean {
    return resolve(filePath) !== resolve(SESSIONS_DIR) && isWithinDir(SESSIONS_DIR, filePath)
  },

  listSessionFiles: () => walk(SESSIONS_DIR, 0),

  async resolveSessionFile(_dirName: string, fileName: string): Promise<string | null> {
    // The UI addresses a rollout two ways the dated tree does not: a parent's
    // virtual `<parent>/subagents/agent-<id>.jsonl` path, and a bare
    // `<id>.jsonl`. Both resolve by id; the literal path under the root is
    // what a listing handed out.
    const idMatch = fileName.match(/\/subagents\/agent-([^.]+)\.jsonl$/)
      ?? fileName.match(/^([^/]+)\.jsonl$/)
    if (idMatch) {
      const resolved = await findSessionFile(idMatch[1])
      if (resolved) return resolved
    }
    // Codex dirNames encode a cwd rather than a directory on disk, so the
    // fileName alone locates the rollout, relative to the sessions root.
    return resolveCanonicalFileWithinRoot(SESSIONS_DIR, SESSIONS_DIR, join(SESSIONS_DIR, fileName))
  },

  findSessionFile,

  readIdentity: readCodexSessionIdentity,

  readSessionMeta: readCodexSessionMeta,

  listProjects: () => projectsFromInventory(codexStore),

  listProjectSessionFiles: (dirName) => projectSessionFilesFromInventory(codexStore, dirName),

  listTopLevelSessions: () => topLevelSessionsFromInventory(codexStore),

  async listSubagentFiles(_dirName: string, parentSessionId: string): Promise<SubagentFileInfo[]> {
    // Rollouts are flat: a sub-agent is any rollout whose header names this
    // session as the one it was spawned from.
    const listing: SubagentFileInfo[] = []
    for (const file of await walk(SESSIONS_DIR, 0)) {
      try {
        const meta = await readCodexSessionMeta(file.filePath, await readTranscriptHead(file.filePath))
        if (!meta.isSubagent || meta.parentSessionId !== parentSessionId) continue
        listing.push({
          agentId: meta.sessionId,
          fileName: file.fileName,
          size: file.size,
          modifiedAt: file.mtimeMs,
        })
      } catch {
        continue
      }
    }
    return listing
  },

  sessionAddress: (filePath) => addressFromTranscript(codexStore, filePath),

  transcriptPath(_dirName, sessionId) {
    const fileName = descriptor.sessionFile.name(sessionId)
    return { filePath: join(SESSIONS_DIR, fileName), fileName }
  },
}

import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { descriptorFor, isSessionUuid } from "../../shared/session/agent-descriptors"
import { isWithinDir } from "../pathSafety"
import { resolveCanonicalFileWithinRoot, statContainedFile } from "./containment"
import type { AgentStore, SessionFileInfo } from "./types"

/**
 * Copilot gives every session its own directory: `<session-state>/<uuid>/`,
 * holding `events.jsonl` plus a `workspace.yaml` sidecar. The project it ran in
 * is not in the path, so listings carry no dirName.
 *
 * The root is captured at module load from the environment, which the test
 * fixtures rely on: they set `COPILOT_HOME` before re-importing the module.
 */

const descriptor = descriptorFor("copilot")

const HOME_DIR = resolve(process.env.COPILOT_HOME || join(homedir(), ".copilot"))
const SESSIONS_DIR = join(HOME_DIR, "session-state")

/** Absolute path of a session's transcript, without checking it exists. */
function transcriptPath(sessionId: string): { sessionDir: string; filePath: string } {
  const sessionDir = join(SESSIONS_DIR, sessionId)
  return { sessionDir, filePath: join(sessionDir, "events.jsonl") }
}

export const copilotStore: AgentStore = {
  kind: "copilot",
  descriptor,

  sessionsRoot: () => SESSIONS_DIR,

  ownsPath(filePath: string): boolean {
    return resolve(filePath) !== resolve(SESSIONS_DIR) && isWithinDir(SESSIONS_DIR, filePath)
  },

  async listSessionFiles(): Promise<SessionFileInfo[]> {
    let entries: Dirent[]
    try {
      entries = await readdir(SESSIONS_DIR, { withFileTypes: true })
    } catch {
      return []
    }

    const results = await Promise.all(entries.map(async (entry): Promise<SessionFileInfo | null> => {
      if (!entry.isDirectory() || !isSessionUuid(entry.name)) return null
      const { filePath } = transcriptPath(entry.name)
      const stats = await statContainedFile(SESSIONS_DIR, filePath)
      if (!stats) return null
      return {
        filePath,
        fileName: descriptor.sessionFile.name(entry.name),
        dirName: null,
        ...stats,
      }
    }))
    return results.flatMap((entry) => entry ? [entry] : [])
  },

  async resolveSessionFile(_dirName: string, fileName: string): Promise<string | null> {
    // Only the exact `<uuid>/events.jsonl` shape addresses a Copilot session;
    // the descriptor's inverse rejects everything else, including a bare
    // `<uuid>.jsonl` and backslash variants.
    const sessionId = descriptor.sessionFile.sessionId(fileName)
    if (!sessionId) return null
    const { sessionDir, filePath } = transcriptPath(sessionId)
    return resolveCanonicalFileWithinRoot(SESSIONS_DIR, sessionDir, filePath)
  },

  async findSessionFile(sessionId: string): Promise<string | null> {
    if (!isSessionUuid(sessionId)) return null
    const { sessionDir, filePath } = transcriptPath(sessionId)
    return resolveCanonicalFileWithinRoot(SESSIONS_DIR, sessionDir, filePath)
  },
}

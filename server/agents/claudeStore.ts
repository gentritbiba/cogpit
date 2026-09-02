import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { descriptorFor } from "../../shared/session/agent-descriptors"
import { dirs } from "../dirs"
import { isWithinDir } from "../pathSafety"
import {
  isSinglePathSegment,
  resolveCanonicalFileWithinRoot,
  statContainedFile,
} from "./containment"
import type { AgentStore, SessionFileInfo } from "./types"

/**
 * Claude Code keeps one directory per project under `~/.claude/projects`, named
 * by a lossy encoding of the cwd, with one `<sessionId>.jsonl` per session.
 *
 * Unlike the other two roots this one is configuration-driven and may not exist
 * at all on an install that only has an external CLI, so every read treats a
 * missing directory as "no history" rather than an error.
 */

const descriptor = descriptorFor("claude")

/** Cogpit's own notes live beside the projects; they are not transcripts. */
const NON_PROJECT_DIRS = new Set(["memory"])

function sessionsRoot(): string | null {
  return dirs.PROJECTS_DIR || null
}

/**
 * Project directories, or none when Claude has no local history.
 *
 * A missing root is normal on an install that only ever used another CLI, but
 * an unreadable one is a real fault the caller has to see — silently returning
 * an empty list would render as "you have no sessions".
 */
async function listProjectDirNames(root: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  return entries
    .filter((entry) => entry.isDirectory() && !NON_PROJECT_DIRS.has(entry.name))
    .map((entry) => entry.name)
}

export const claudeStore: AgentStore = {
  kind: "claude",
  descriptor,

  sessionsRoot,

  ownsPath(filePath: string): boolean {
    const root = sessionsRoot()
    if (!root) return false
    return resolve(filePath) !== resolve(root) && isWithinDir(root, filePath)
  },

  async listSessionFiles(): Promise<SessionFileInfo[]> {
    const root = sessionsRoot()
    if (!root) return []

    const files: SessionFileInfo[] = []
    for (const dirName of await listProjectDirNames(root)) {
      const projectDir = join(root, dirName)
      let names: string[]
      try {
        names = await readdir(projectDir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue
        const filePath = join(projectDir, name)
        const stats = await statContainedFile(root, filePath)
        if (!stats) continue
        files.push({ filePath, fileName: name, dirName, ...stats })
      }
    }
    return files
  },

  async resolveSessionFile(dirName: string, fileName: string): Promise<string | null> {
    const root = sessionsRoot()
    if (!root) return null
    // A project dirName is one directory entry; the fileName may still nest,
    // because subagent transcripts live at `<sessionId>/subagents/agent-*.jsonl`.
    if (!isSinglePathSegment(dirName)) return null
    const projectDir = join(root, dirName)
    return resolveCanonicalFileWithinRoot(root, projectDir, join(projectDir, fileName))
  },

  async findSessionFile(sessionId: string): Promise<string | null> {
    const root = sessionsRoot()
    if (!root || !isSinglePathSegment(sessionId)) return null

    const targetFile = descriptor.sessionFile.name(sessionId)
    // A lookup that cannot read the root just misses; it is not the caller's
    // problem the way a listing that silently comes back empty would be.
    const dirNames = await listProjectDirNames(root).catch(() => [])
    for (const dirName of dirNames) {
      const projectDir = join(root, dirName)
      try {
        const names = await readdir(projectDir)
        if (names.includes(targetFile)) return join(projectDir, targetFile)
      } catch {
        continue
      }
    }
    return null
  },
}

import type { Dirent } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { descriptorFor } from "../../shared/session/agent-descriptors"
import { dirs } from "../dirs"
import { isWithinDir } from "../pathSafety"
import { readClaudeSessionMeta } from "./claudeMetadata"
import {
  isSinglePathSegment,
  resolveCanonicalFileWithinRoot,
  statContainedFile,
} from "./containment"
import { readTranscriptHead } from "./transcriptHead"
import type {
  AgentProjectEntry,
  AgentStore,
  ProjectSessionFileInfo,
  SessionFileInfo,
  SubagentFileInfo,
} from "./types"

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

async function listSessionFiles(): Promise<SessionFileInfo[]> {
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
}

/** The project directories, each carrying the sessions listed under it. */
async function listProjects(): Promise<AgentProjectEntry[]> {
  const byDirName = new Map<string, SessionFileInfo[]>()
  for (const file of await listSessionFiles()) {
    if (file.dirName === null) continue
    const bucket = byDirName.get(file.dirName)
    if (bucket) bucket.push(file)
    else byDirName.set(file.dirName, [file])
  }

  const projects: AgentProjectEntry[] = []
  for (const [dirName, files] of byDirName) {
    const newest = files.reduce((a, b) => a.mtimeMs >= b.mtimeMs ? a : b)
    // The dirName encoding is lossy for paths containing hyphens, so the cwd
    // the newest session recorded is the better answer when readable.
    let cwd: string | null = null
    try {
      const meta = await readClaudeSessionMeta(newest.filePath, await readTranscriptHead(newest.filePath))
      cwd = meta.cwd || null
    } catch { /* ignore, fall back to the derived path */ }

    projects.push({
      dirName,
      path: cwd ?? descriptor.dirName.decode(dirName) ?? dirName,
      sessionCount: files.length,
      lastModified: newest.mtimeMs ? new Date(newest.mtimeMs).toISOString() : null,
    })
  }
  return projects
}

async function listProjectSessionFiles(dirName: string): Promise<ProjectSessionFileInfo[] | null> {
  const root = sessionsRoot()
  if (!root || !isSinglePathSegment(dirName)) return null
  const projectDir = join(root, dirName)
  if (!isWithinDir(root, projectDir)) return null

  const names = await readdir(projectDir)
  return Promise.all(names.filter((name) => name.endsWith(".jsonl")).map(async (fileName) => {
    const filePath = join(projectDir, fileName)
    try {
      const fileStat = await stat(filePath)
      return { filePath, fileName, dirName, mtimeMs: fileStat.mtimeMs, size: fileStat.size }
    } catch {
      return { filePath, fileName, dirName, mtimeMs: 0, size: 0 }
    }
  }))
}

/** Sub-agent transcripts sit beside their parent: `<session>/subagents/agent-<id>.jsonl`. */
async function listSubagentFiles(dirName: string, sessionId: string): Promise<SubagentFileInfo[] | null> {
  const root = sessionsRoot()
  if (!root) return null
  const subagentsDir = join(root, dirName, sessionId, "subagents")
  if (!isWithinDir(root, subagentsDir)) return null

  let names: string[]
  try {
    names = await readdir(subagentsDir)
  } catch {
    return []
  }
  const listing: SubagentFileInfo[] = []
  for (const name of names) {
    if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue
    const agentId = name.replace("agent-", "").replace(".jsonl", "")
    try {
      const fileStat = await stat(join(subagentsDir, name))
      listing.push({ agentId, size: fileStat.size, modifiedAt: fileStat.mtimeMs })
    } catch {
      continue
    }
  }
  return listing
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

  listSessionFiles,

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

  // No head-only fast path: the full read is what the listings need anyway.
  readIdentity: async () => null,

  readSessionMeta: readClaudeSessionMeta,

  listProjects,

  listProjectSessionFiles,

  // The path names the project and the file names the session, so the listing
  // is already every top-level session.
  async listTopLevelSessions() {
    return (await listSessionFiles()).flatMap((file) =>
      file.dirName === null ? [] : [{ ...file, dirName: file.dirName }],
    )
  },

  listSubagentFiles,

  async sessionAddress(filePath) {
    return { dirName: basename(dirname(filePath)), fileName: basename(filePath) }
  },

  transcriptPath(dirName, sessionId) {
    const root = sessionsRoot()
    if (!root) return null
    const fileName = descriptor.sessionFile.name(sessionId)
    return { filePath: join(root, dirName, fileName), fileName }
  },
}

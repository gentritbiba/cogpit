import type { Dirent } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { descriptorFor, type AgentDescriptor } from "../../shared/session/agent-descriptors"
import { dirs } from "../dirs"
import { isWithinDir } from "../pathSafety"
import { readClaudeSessionMeta } from "./claudeMetadata"
import {
  canonicalPathWithin,
  isSinglePathSegment,
  resolveCanonicalFileWithinRoot,
  statContainedFile,
} from "./containment"
import { HEAD_BYTES, readHeadLines, readTranscriptHead } from "./transcriptHead"
import { isClaudeNoiseLine } from "../../shared/session/claude"
import {
  catalogListings,
  createStoreCatalog,
  descriptorAddressing,
  walkStore,
  type CatalogDirListing,
  type StoreCatalogSource,
} from "../sessionCatalog/storeCatalog"
import { ownTranscripts } from "./transcriptInventory"
import type {
  AgentStore,
  ProjectSessionFileInfo,
  SessionFileInfo,
  SubagentFileInfo,
  TranscriptFileInfo,
} from "./types"

/** Caps the files one freshness check stats; a session can hold hundreds of agent transcripts. */
const AGENT_TRANSCRIPT_STAT_BUDGET = 1000

/** A sub-agent's own sub-agents sit under `agent-<id>/subagents/`; nothing legitimate nests deeper. */
const MAX_SUBAGENT_DEPTH = 4

/**
 * Claude Code keeps one directory per project under `~/.claude/projects`, named
 * by a lossy encoding of the cwd, with one `<sessionId>.jsonl` per session.
 *
 * Unlike the other two roots this one is configuration-driven and may not exist
 * at all on an install that only has an external CLI, so every read treats a
 * missing directory as "no history" rather than an error.
 */

export function createClaudeStore(projectsRoot?: string, configuredDescriptor?: AgentDescriptor): AgentStore {
  const descriptor = configuredDescriptor ?? descriptorFor("claude")

  /** Cogpit's own notes live beside the projects; they are not transcripts. */
  const NON_PROJECT_DIRS = new Set(["memory"])

  function sessionsRoot(): string | null {
    return projectsRoot ?? (dirs.PROJECTS_DIR || null)
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

  /** The root holds project directories; each project directory holds its sessions. */
  async function listDir(root: string, dir: string, depth: number): Promise<CatalogDirListing> {
    if (depth === 0) return { files: [], dirs: (await listProjectDirNames(root)).map((dirName) => join(root, dirName)) }
    const dirName = basename(dir)
    const files: SessionFileInfo[] = []
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".jsonl")) continue
      const filePath = join(dir, name)
      const stats = await statContainedFile(root, filePath)
      if (stats) files.push({ filePath, fileName: name, dirName, ...stats })
    }
    return { files, dirs: [] }
  }

  async function readProjectPath(filePath: string): Promise<{ path: string | null; final: boolean }> {
    for (const line of await readHeadLines(filePath, HEAD_BYTES)) {
      if (isClaudeNoiseLine(line)) continue
      try {
        const record = JSON.parse(line) as { cwd?: unknown }
        if (typeof record.cwd === "string" && record.cwd) return { path: record.cwd, final: true }
      } catch { /* skip malformed */ }
    }
    // A head without one leaves the full read, which also scans the tail.
    const meta = await readClaudeSessionMeta(filePath, await readTranscriptHead(filePath))
    return { path: meta.cwd || null, final: false }
  }

  const catalogSource: StoreCatalogSource = {
    root: sessionsRoot,
    listDir,
    ...descriptorAddressing(descriptor),
    readIdentity: async () => null,
    readSessionMeta: readClaudeSessionMeta,
    identityIsFinal: () => false,
    readProjectPath,
  }
  const catalog = createStoreCatalog(catalogSource)

  async function listSessionFiles(): Promise<SessionFileInfo[]> {
    const root = sessionsRoot()
    return root ? (await walkStore(catalogSource, root)).files : []
  }

  /** `<parent>/subagents/agent-<id>.jsonl`, and the same beside each of those, filed under the root session. */
  async function listSubagentTranscripts(root: string, parentPath: string, sessionId: string, depth: number): Promise<TranscriptFileInfo[]> {
    if (depth >= MAX_SUBAGENT_DEPTH) return []
    const dir = join(parentPath.replace(/\.jsonl$/, ""), "subagents")
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const found: TranscriptFileInfo[] = []
    for (const name of names) {
      const agentId = /^agent-(.+)\.jsonl$/.exec(name)?.[1]
      if (!agentId) continue
      const filePath = join(dir, name)
      const stats = await statContainedFile(root, filePath)
      if (stats) found.push({ filePath, ...stats, sessionId, isSubagent: true, parentSessionId: sessionId, agentId })
      found.push(...await listSubagentTranscripts(root, filePath, sessionId, depth + 1))
    }
    return found
  }

  async function listTranscripts(): Promise<TranscriptFileInfo[]> {
    const root = sessionsRoot()
    if (!root) return []
    const sessions = ownTranscripts(descriptor, await listSessionFiles())
    const subagents = await Promise.all(sessions.map((session) => listSubagentTranscripts(root, session.filePath, session.sessionId, 0)))
    return [...sessions, ...subagents.flat()]
  }

  async function listProjectSessionFiles(dirName: string): Promise<ProjectSessionFileInfo[] | null> {
    const root = sessionsRoot()
    if (!root || !isSinglePathSegment(dirName)) return null
    const projectDir = join(root, dirName)
    if (!isWithinDir(root, projectDir)) return null
    const listed = await catalog.projectSessionFiles(dirName)
    if (listed.length > 0) return listed

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

  /** Background agents write to `subagents/`, workflow agents to `subagents/workflows/<run>/`. */
  async function agentsWroteSince(dirName: string, sessionId: string, sinceMs: number): Promise<boolean> {
    const root = sessionsRoot()
    if (!root) return false
    const subagentsDir = join(root, dirName, sessionId, "subagents")
    if (!isWithinDir(root, subagentsDir)) return false

    const queue = [{ dir: subagentsDir, depth: 0 }]
    let statBudget = AGENT_TRANSCRIPT_STAT_BUDGET
    while (queue.length > 0) {
      const { dir, depth } = queue.shift()!
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (depth < 2) queue.push({ dir: join(dir, entry.name), depth: depth + 1 })
          continue
        }
        if (!entry.name.endsWith(".jsonl")) continue
        if (statBudget-- <= 0) return false
        const fileStat = await stat(join(dir, entry.name)).catch(() => null)
        if (fileStat && fileStat.mtimeMs >= sinceMs) return true
      }
    }
    return false
  }

  const claudeStore: AgentStore = {
    kind: descriptor.kind,
    descriptor,

    sessionsRoot,

    ownsPath(filePath: string): boolean {
      const root = sessionsRoot()
      if (!root) return false
      return resolve(filePath) !== resolve(root) && isWithinDir(root, filePath)
    },

    listSessionFiles,
    listTranscripts,

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

    async transcriptRoot(filePath) {
      const root = sessionsRoot()
      const pathInRoot = root ? await canonicalPathWithin(root, filePath) : null
      if (!pathInRoot) return null
      // The codec reads a path relative to its project directory, the first segment here.
      const projectEnd = pathInRoot.indexOf("/")
      if (projectEnd <= 0) return null
      return descriptor.sessionFile.transcriptRoot(pathInRoot.slice(projectEnd + 1))
    },

    // No head-only fast path: the full read is what the listings need anyway.
    readIdentity: async () => null,

    readSessionMeta: readClaudeSessionMeta,

    // The path names the project and the file names the session, so every
    // listed file is a top-level session.
    ...catalogListings(catalog),

    listProjectSessionFiles,

    listSubagentFiles,
    agentsWroteSince,

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
  return claudeStore
}

export const claudeStore = createClaudeStore()

import { relative, sep } from "node:path"
import { inventoryFor, type SessionInventoryEntry } from "./sessionInventory"
import { readTranscriptHead } from "./transcriptHead"
import type {
  AgentProjectEntry,
  AgentStore,
  ProjectSessionFileInfo,
  SessionAddress,
  TopLevelSessionInfo,
} from "./types"

/**
 * Store operations for an agent whose transcripts record the project only
 * inside the file. Every answer here is an inventory read, grouped or filtered
 * by the cwd each session carried.
 */

async function topLevelEntries(store: AgentStore): Promise<SessionInventoryEntry[]> {
  return (await inventoryFor(store)).filter((entry) => !entry.isSubagent)
}

export async function projectsFromInventory(store: AgentStore): Promise<AgentProjectEntry[]> {
  const byCwd = new Map<string, SessionInventoryEntry[]>()
  for (const entry of await topLevelEntries(store)) {
    const bucket = byCwd.get(entry.cwd)
    if (bucket) bucket.push(entry)
    else byCwd.set(entry.cwd, [entry])
  }
  return [...byCwd].map(([cwd, files]) => {
    const latestTime = Math.max(...files.map((file) => file.mtimeMs))
    return {
      dirName: store.descriptor.dirName.encode(cwd),
      path: cwd,
      sessionCount: files.length,
      lastModified: latestTime ? new Date(latestTime).toISOString() : null,
    }
  })
}

export async function projectSessionFilesFromInventory(
  store: AgentStore,
  dirName: string,
): Promise<ProjectSessionFileInfo[] | null> {
  const cwd = store.descriptor.dirName.decode(dirName)
  if (!cwd) return null
  return (await topLevelEntries(store))
    .filter((entry) => entry.cwd === cwd)
    .map((entry) => ({
      filePath: entry.filePath,
      fileName: entry.fileName,
      dirName,
      mtimeMs: entry.mtimeMs,
      size: entry.size,
      sessionId: entry.sessionId,
    }))
}

export async function topLevelSessionsFromInventory(store: AgentStore): Promise<TopLevelSessionInfo[]> {
  return (await topLevelEntries(store)).map((entry) => ({
    filePath: entry.filePath,
    fileName: entry.fileName,
    dirName: store.descriptor.dirName.encode(entry.cwd),
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    projectPath: entry.cwd,
    sessionId: entry.sessionId,
  }))
}

/** The session is addressed by the cwd only its transcript knows, and by its path under the root. */
export async function addressFromTranscript(
  store: AgentStore,
  filePath: string,
): Promise<SessionAddress | null> {
  const root = store.sessionsRoot()
  if (!root) return null
  const meta = await store.readSessionMeta(filePath, await readTranscriptHead(filePath))
  return {
    dirName: store.descriptor.dirName.encode(meta.cwd || ""),
    fileName: relative(root, filePath).split(sep).join("/"),
  }
}

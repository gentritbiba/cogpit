import { relative, sep } from "node:path"
import type { StoreCatalog } from "../sessionCatalog/storeCatalog"
import { uncompressedTranscriptName } from "./transcriptFile"
import { readTranscriptHead } from "./transcriptHead"
import type { AgentStore, ProjectSessionFileInfo, SessionAddress } from "./types"

/**
 * Store operations for an agent whose transcripts record the project only
 * inside the file, answered from the identities its catalog placed them by.
 */

export async function projectSessionFilesFromCatalog(
  store: AgentStore,
  catalog: StoreCatalog,
  dirName: string,
): Promise<ProjectSessionFileInfo[] | null> {
  const cwd = store.descriptor.dirName.decode(dirName)
  if (!cwd) return null
  return (await catalog.topLevelSessions())
    .filter((session) => session.projectPath === cwd)
    .map(({ filePath, fileName, mtimeMs, size, sessionId }) => ({ filePath, fileName, dirName, mtimeMs, size, sessionId }))
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
    fileName: uncompressedTranscriptName(relative(root, filePath)).split(sep).join("/"),
  }
}

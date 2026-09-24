import { storeForDirName } from "./index"
import { lineageFromMeta, type TrustedLineage } from "./lineage"

/** The top-level session a transcript address belongs to, and the file it reaches. */
export interface TranscriptSession {
  /** Lowercased. */
  sessionId: string
  filePath: string
  /** False for a transcript filed under the session — a sub-agent's or a workflow's. */
  isRootTranscript: boolean
  /** Lineage to check the session by, for its own transcript only: discovery may read no other. */
  hint?: TrustedLineage
}

/**
 * The session whose transcript `{dirName, fileName}` reaches, read from where
 * the file really lives, so an address that spells another session or climbs
 * out with `..` names only the file a read would return. Null when the owning
 * store serves no transcript there.
 */
export async function resolveTranscriptSession(dirName: string, fileName: string): Promise<TranscriptSession | null> {
  const store = storeForDirName(dirName)
  const filePath = await store.resolveSessionFile(dirName, fileName)
  const root = filePath === null ? null : await store.transcriptRoot(filePath)
  if (filePath === null || root === null) return null
  return {
    sessionId: root.rootSessionId,
    filePath,
    isRootTranscript: root.isRootTranscript,
    hint: root.isRootTranscript
      ? lineageFromMeta({ sessionId: root.rootSessionId, parentSessionId: null }, filePath)
      : undefined,
  }
}

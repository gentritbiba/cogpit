import { lineageFromMeta, type TrustedLineage } from "./lineage"

interface ListedTranscript {
  /** Present when the listing had to read the file to place it. */
  sessionId?: string
  fileName: string
  filePath: string
}

/** The id a listed top-level transcript names its session by: the listing's own, else the file's name. */
export function listedSessionId(file: Pick<ListedTranscript, "sessionId" | "fileName">): string {
  return file.sessionId || file.fileName.replace(/\.jsonl$/, "")
}

/**
 * A listed top-level session, with the lineage to check it by. The transcript
 * is the session's own, so lineage discovery reads it instead of looking the
 * id up.
 */
export function listedSession(file: ListedTranscript): { sessionId: string; hint: TrustedLineage } {
  const sessionId = listedSessionId(file)
  return { sessionId, hint: lineageFromMeta({ sessionId, parentSessionId: null }, file.filePath) }
}

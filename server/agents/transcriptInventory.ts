import type { AgentDescriptor } from "../../shared/session/agent-descriptors"
import type { SessionFileInfo, TranscriptFileInfo } from "./types"

/** Listed transcripts that are each a session of their own, named by the descriptor's file codec. */
export function ownTranscripts(descriptor: AgentDescriptor, files: readonly SessionFileInfo[]): TranscriptFileInfo[] {
  return files.flatMap(({ filePath, fileName, mtimeMs, size }) => {
    const sessionId = descriptor.sessionFile.sessionId(fileName)
    return sessionId ? [{ filePath, mtimeMs, size, sessionId, isSubagent: false, parentSessionId: null, agentId: null }] : []
  })
}

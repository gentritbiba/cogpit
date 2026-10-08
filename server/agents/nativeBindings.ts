import { readTranscriptHead } from "./transcriptHead"
import type { NativeBinding } from "../../shared/contracts/orchestration"
import type { AgentKind } from "../../shared/session/agent-descriptors"
import { splitInstanceSessionId } from "../../shared/session/instances"
import { findJsonlPath } from "../sessionPaths"
export async function nativeBinding(sessionId: string, kind: AgentKind, filePath?: string | null, cwd?: string): Promise<NativeBinding> {
  const parts = splitInstanceSessionId(sessionId)
  filePath ??= await findJsonlPath(sessionId)
  let nativeSessionId = parts.nativeId
  if (kind === "acp" && filePath) {
    const head = await readTranscriptHead(filePath)
    const record: unknown = head.lines[0] ? JSON.parse(head.lines[0]) : null
    if (record && typeof record === "object" && "nativeSessionId" in record && typeof record.nativeSessionId === "string") nativeSessionId = record.nativeSessionId
  }
  return { hostId: "local", agent: kind, instanceId: parts.instanceId, sessionId, nativeSessionId, filePath, cwd }
}

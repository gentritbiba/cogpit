import { stat } from "node:fs/promises"
import { parseSession } from "../../shared/session/parser"
import { sharedAgentCheck } from "../agents/agentCheck"
import { allRuntimes } from "../agents/runtimes"
import { readTranscriptText } from "../agents/transcriptFile"
import { findJsonlPath } from "../sessionPaths"
import type { TelemetryEvents } from "./events"
import type { ReadSessionTurns } from "./turns"

/** Where usage data reads sessions and agents from; kept apart so the telemetry module stays a leaf. */
export const readSessionTurns: ReadSessionTurns = async (sessionId, knownMtimeMs) => {
  const filePath = await findJsonlPath(sessionId)
  if (!filePath) return null
  const info = await stat(filePath).catch(() => null)
  if (!info || info.mtimeMs === knownMtimeMs) return null
  const parsed = parseSession(await readTranscriptText(filePath), { skipStats: true })
  return {
    agent: parsed.agentKind ?? "unknown",
    mtimeMs: info.mtimeMs,
    running: allRuntimes().some((runtime) => runtime.activity(sessionId).running),
    turns: parsed.turns,
  }
}

export async function readAgentStatus(): Promise<TelemetryEvents["agent.status"][]> {
  return (await sharedAgentCheck()).map((check) => {
    const version = check.version?.match(/\d+(?:\.\d+){1,2}/)?.[0]
    return {
      agent: check.kind,
      installed: check.binary !== null,
      signedIn: check.signedIn,
      ...(version ? { version } : {}),
    }
  })
}

import type { AgentKind } from "@/lib/agents"

/** The transcript an open session reads, and which load of it is on screen. */
export interface SessionSource {
  dirName: string
  fileName: string
  agentKind?: AgentKind
  /** Native byte offset the loaded session reflects the transcript up to; the live stream resumes here. */
  watchOffset: number
  /** Changes whenever the session is loaded from disk again, never while it streams. */
  loadId: number
}

let lastLoadId = 0

export function nextLoadId(): number {
  lastLoadId += 1
  return lastLoadId
}

import { describe, expect, it } from "vitest"
import { countLiveSessions } from "../liveSessionSummary"
import type { ActiveSessionInfo, RunningProcess } from "../SessionRow"

function session(sessionId: string, agentStatus: ActiveSessionInfo["agentStatus"]): ActiveSessionInfo {
  return {
    dirName: "project",
    projectShortName: "project",
    fileName: `${sessionId}.jsonl`,
    sessionId,
    lastModified: "2026-07-12T10:00:00.000Z",
    size: 100,
    isActive: false,
    agentStatus,
  }
}

function process(sessionId: string): RunningProcess {
  return {
    pid: 42,
    memMB: 100,
    cpu: 1,
    sessionId,
    tty: "",
    args: "codex",
    startTime: "2026-07-12T10:00:00.000Z",
  }
}

describe("countLiveSessions", () => {
  it("counts matched running sessions, not recently modified history", () => {
    const sessions = [
      session("running", "processing"),
      session("historical", "idle"),
    ]
    const processes = new Map([["running", process("running")]])

    expect(countLiveSessions(sessions, processes)).toBe(1)
  })

  it("does not count a completed session during process cleanup", () => {
    const sessions = [session("done", "completed")]
    const processes = new Map([["done", process("done")]])

    expect(countLiveSessions(sessions, processes)).toBe(0)
  })

  it("counts a native app-server turn without a fake process", () => {
    const native = session("native-codex", "completed")
    native.isActive = true

    expect(countLiveSessions([native], new Map())).toBe(1)
  })
})

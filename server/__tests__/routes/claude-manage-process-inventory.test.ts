// @vitest-environment node
import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { activeProcesses, persistentSessions, spawn } = vi.hoisted(() => ({
  activeProcesses: new Map(),
  persistentSessions: new Map(),
  spawn: vi.fn(),
}))

vi.mock("../../helpers", () => ({ activeProcesses, persistentSessions, spawn }))

import {
  parseAgentProcessOutput,
  registerRunningProcessesRoute,
} from "../../routes/claude-manage/processInventory"

const CLAUDE_SESSION_ID = "11111111-1111-1111-1111-111111111111"
const CODEX_SESSION_ID = "22222222-2222-2222-2222-222222222222"

describe("parseAgentProcessOutput", () => {
  it("parses and memory-sorts POSIX agent processes", () => {
    const stdout = [
      `alice 1001 4.5 0.1 0 2097152 ttys001 S+ 10:00 0:01.00 claude --resume ${CLAUDE_SESSION_ID}`,
      `alice 1002 1.5 0.1 0 1024 ttys002 S+ 10:01 0:00.50 codex exec resume ${CODEX_SESSION_ID}`,
    ].join("\n")

    expect(parseAgentProcessOutput(stdout, "darwin")).toEqual([
      expect.objectContaining({
        pid: 1001,
        memMB: 2048,
        cpu: 4.5,
        sessionId: CLAUDE_SESSION_ID,
        agentKind: "claude",
      }),
      expect.objectContaining({
        pid: 1002,
        memMB: 1,
        cpu: 1.5,
        sessionId: CODEX_SESSION_ID,
        agentKind: "codex",
      }),
    ])
  })

  it("prefers a tracked session ID and filters shell/tooling processes", () => {
    const stdout = [
      `alice 1001 2.0 0.1 0 2048 ttys001 S+ 10:00 0:01.00 claude --session-id ${CLAUDE_SESSION_ID}`,
      "alice 1002 1.0 0.1 0 1024 ttys002 S+ 10:01 0:00.50 node claude-helper.js",
      "alice 1003 1.0 0.1 0 1024 ttys003 S+ 10:02 0:00.50 /bin/zsh codex",
    ].join("\n")

    const processes = parseAgentProcessOutput(
      stdout,
      "linux",
      new Map([[1001, "tracked-session"]]),
    )

    expect(processes).toHaveLength(1)
    expect(processes[0].sessionId).toBe("tracked-session")
  })

  it("parses PowerShell singleton output", () => {
    const stdout = JSON.stringify({
      ProcessId: 2001,
      WorkingSetSize: 100 * 1024 * 1024,
      CommandLine: `codex exec resume ${CODEX_SESSION_ID}`,
    })

    expect(parseAgentProcessOutput(stdout, "win32")).toEqual([{
      pid: 2001,
      memMB: 100,
      cpu: 0,
      sessionId: CODEX_SESSION_ID,
      agentKind: "codex",
      tty: "??",
      args: `codex exec resume ${CODEX_SESSION_ID}`,
      startTime: "",
    }])
  })

  it("treats empty or invalid PowerShell output as an empty inventory", () => {
    expect(parseAgentProcessOutput("", "win32")).toEqual([])
    expect(parseAgentProcessOutput("not-json", "win32")).toEqual([])
  })
})

describe("registerRunningProcessesRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeProcesses.clear()
    persistentSessions.clear()
  })

  it("streams process output through the parser and responds once", () => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter }
    child.stdout = new EventEmitter()
    spawn.mockReturnValue(child)
    const handlers = new Map<string, (...args: never[]) => unknown>()
    registerRunningProcessesRoute((path, handler) => { handlers.set(path, handler as never) })
    const res = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn(),
    }
    const next = vi.fn()
    const handler = handlers.get("/api/running-processes")!

    handler({ method: "GET", url: "/" } as never, res as never, next as never)
    child.stdout.emit(
      "data",
      Buffer.from(`alice 1001 2.0 0.1 0 2048 ttys001 S+ 10:00 0:01.00 claude --resume ${CLAUDE_SESSION_ID}`),
    )
    child.emit("close")
    child.emit("close")

    expect(spawn).toHaveBeenCalledWith("ps", ["aux"])
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual([
      expect.objectContaining({ pid: 1001, sessionId: CLAUDE_SESSION_ID }),
    ])
    expect(res.end).toHaveBeenCalledTimes(1)
    expect(next).not.toHaveBeenCalled()
  })

  it("forwards unsupported methods and nested paths", () => {
    const handlers = new Map<string, (...args: never[]) => unknown>()
    registerRunningProcessesRoute((path, handler) => { handlers.set(path, handler as never) })
    const handler = handlers.get("/api/running-processes")!
    const next = vi.fn()

    handler({ method: "POST", url: "/" } as never, {} as never, next as never)
    handler({ method: "GET", url: "/nested" } as never, {} as never, next as never)

    expect(next).toHaveBeenCalledTimes(2)
    expect(spawn).not.toHaveBeenCalled()
  })
})

// @vitest-environment node

import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"

const mockPtySpawn = vi.hoisted(() => vi.fn())
const mockExecFileSync = vi.hoisted(() => vi.fn())

vi.mock("node-pty", () => ({ spawn: mockPtySpawn }))
vi.mock("node:child_process", () => ({ execFileSync: mockExecFileSync }))
const mockSignInLaunch = vi.hoisted(() => vi.fn())
vi.mock("../agents/signIn", () => ({ agentSignInLaunch: mockSignInLaunch }))

import { PtySessionManager } from "../pty-server"

class FakeSocket extends EventEmitter {
  readonly sent: string[] = []
  readyState: number = WebSocket.OPEN
  readonly closes: Array<{ code?: number; reason?: string }> = []

  send(message: string): void {
    this.sent.push(message)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
    this.readyState = WebSocket.CLOSING
    this.emit("close")
  }
}

function messages(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>)
}

/** Run `fn` as if the server were on `platform`. */
function onPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { ...original, value: platform })
  try {
    fn()
  } finally {
    Object.defineProperty(process, "platform", original)
  }
}

function fakePty(pid = 4242) {
  return {
    pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  }
}

function spawnSession(id: string) {
  const pty = fakePty()
  mockPtySpawn.mockReturnValue(pty)
  const socket = new FakeSocket()
  const manager = new PtySessionManager({ clients: new Set([socket]) } as never)
  manager.handleConnection(socket as never)
  socket.emit("message", Buffer.from(JSON.stringify({ type: "spawn", id })))
  return { pty, manager, socket }
}

describe("PtySessionManager", () => {
  beforeEach(() => {
    mockPtySpawn.mockReset()
    mockExecFileSync.mockReset()
  })

  afterEach(() => vi.useRealTimers())

  it("closes an established socket when its authorization later expires", () => {
    vi.useFakeTimers()
    let authorized = true
    const socket = new FakeSocket()
    const manager = new PtySessionManager({ clients: new Set([socket]) } as never)
    manager.handleConnection(socket as never, () => authorized)

    authorized = false
    vi.advanceTimersByTime(5_000)

    expect(socket.closes).toEqual([{
      code: 1008,
      reason: "Session authorization expired",
    }])
    manager.cleanup()
  })

  it("rejects a duplicate session ID before spawning or losing the original PTY", () => {
    const pty = {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    }
    mockPtySpawn.mockReturnValue(pty)
    const socket = new FakeSocket()
    const manager = new PtySessionManager({ clients: new Set([socket]) } as never)
    manager.handleConnection(socket as never)

    const spawn = JSON.stringify({ type: "spawn", id: "terminal-1" })
    socket.emit("message", Buffer.from(spawn))
    socket.emit("message", Buffer.from(spawn))

    expect(mockPtySpawn).toHaveBeenCalledTimes(1)
    expect(messages(socket)).toContainEqual({
      type: "error",
      id: "terminal-1",
      message: "Session ID already exists",
    })
    expect(pty.kill).not.toHaveBeenCalled()

    manager.cleanup()
    expect(pty.kill).toHaveBeenCalledOnce()
  })

  describe("default shell", () => {
    it("spawns COMSPEC on Windows, where SHELL is never set", () => {
      const comspec = process.env.COMSPEC
      process.env.COMSPEC = "C:\\Windows\\system32\\cmd.exe"
      try {
        onPlatform("win32", () => spawnSession("terminal-win"))
      } finally {
        if (comspec === undefined) delete process.env.COMSPEC
        else process.env.COMSPEC = comspec
      }

      expect(mockPtySpawn).toHaveBeenCalledWith(
        "C:\\Windows\\system32\\cmd.exe",
        [],
        expect.objectContaining({ name: "xterm-256color" }),
      )
    })

    it("falls back to powershell.exe when COMSPEC is missing", () => {
      const comspec = process.env.COMSPEC
      delete process.env.COMSPEC
      try {
        onPlatform("win32", () => spawnSession("terminal-win-fallback"))
      } finally {
        if (comspec !== undefined) process.env.COMSPEC = comspec
      }

      expect(mockPtySpawn.mock.calls[0][0]).toBe("powershell.exe")
    })

    it("keeps using SHELL elsewhere", () => {
      onPlatform("darwin", () => spawnSession("terminal-posix"))
      expect(mockPtySpawn.mock.calls[0][0]).toBe(process.env.SHELL ?? "/bin/zsh")
    })
  })

  describe("killing sessions", () => {
    it("kills the whole tree on Windows, where node-pty would orphan children", () => {
      onPlatform("win32", () => {
        const { pty, socket } = spawnSession("terminal-kill")
        socket.emit("message", Buffer.from(JSON.stringify({ type: "kill", id: "terminal-kill" })))

        expect(mockExecFileSync).toHaveBeenCalledWith(
          "taskkill",
          ["/pid", "4242", "/T", "/F"],
          expect.objectContaining({ windowsHide: true }),
        )
        expect(pty.kill).not.toHaveBeenCalled()
      })
    })

    it("falls back to node-pty when taskkill fails", () => {
      onPlatform("win32", () => {
        mockExecFileSync.mockImplementation(() => {
          throw new Error("not found")
        })
        const { pty, manager } = spawnSession("terminal-taskkill-fails")
        manager.cleanup()
        expect(pty.kill).toHaveBeenCalledOnce()
      })
    })

    it("signals the PTY directly elsewhere", () => {
      onPlatform("darwin", () => {
        const { pty, socket } = spawnSession("terminal-kill-posix")
        socket.emit("message", Buffer.from(JSON.stringify({ type: "kill", id: "terminal-kill-posix" })))

        expect(mockExecFileSync).not.toHaveBeenCalled()
        expect(pty.kill).toHaveBeenCalledOnce()
      })
    })
  })
})

describe("PtySessionManager sign-in terminals", () => {
  beforeEach(() => {
    mockPtySpawn.mockReset()
    mockSignInLaunch.mockReset()
  })

  function spawnSignIn(signIn: unknown) {
    mockPtySpawn.mockReturnValue(fakePty())
    const socket = new FakeSocket()
    const manager = new PtySessionManager({ clients: new Set([socket]) } as never)
    manager.handleConnection(socket as never)
    socket.emit("message", Buffer.from(JSON.stringify({ type: "spawn", id: "sign-in", command: "/bin/sh", args: ["-l"], signIn })))
    return { manager, socket }
  }

  it("runs the launch the server builds for the agent and account, never the client's command", () => {
    mockSignInLaunch.mockReturnValue({ command: "/opt/codex/bin/codex", args: ["login"], verbatimArgs: false, env: { HOME: "/data/instances/work/user" } })
    const { manager } = spawnSignIn({ agent: "codex", instanceId: "work" })

    expect(mockSignInLaunch).toHaveBeenCalledWith("codex", "work")
    const [command, args, options] = mockPtySpawn.mock.calls[0]
    expect(command).toBe("/opt/codex/bin/codex")
    expect(args).toEqual(["login"])
    expect(options.env).toMatchObject({ HOME: "/data/instances/work/user", TERM: "xterm-256color" })
    manager.cleanup()
  })

  it("hands cmd.exe its command line verbatim for a Windows batch shim", () => {
    mockSignInLaunch.mockReturnValue({
      command: "C:\\Windows\\system32\\cmd.exe",
      args: ["/d", "/s", "/c", "\"^\"C:\\npm\\codex.cmd^\" login\""],
      verbatimArgs: true,
      env: {},
    })
    const { manager } = spawnSignIn({ agent: "codex", instanceId: null })

    expect(mockSignInLaunch).toHaveBeenCalledWith("codex", null)
    expect(mockPtySpawn.mock.calls[0][1]).toBe("/d /s /c \"^\"C:\\npm\\codex.cmd^\" login\"")
    manager.cleanup()
  })

  it("reports an agent with no sign-in instead of starting anything", () => {
    mockSignInLaunch.mockReturnValue(null)
    const { manager, socket } = spawnSignIn({ agent: "acp" })

    expect(mockPtySpawn).not.toHaveBeenCalled()
    expect(messages(socket)).toContainEqual(expect.objectContaining({ type: "error", id: "sign-in", message: expect.stringContaining("no sign-in") }))
    manager.cleanup()
  })

  it("starts the requested terminal when the sign-in names no known agent", () => {
    mockPtySpawn.mockReturnValue(fakePty())
    const { manager } = spawnSignIn({ agent: "rm -rf" })
    expect(mockSignInLaunch).not.toHaveBeenCalled()
    expect(mockPtySpawn.mock.calls[0][0]).toBe("/bin/sh")
    manager.cleanup()
  })
})

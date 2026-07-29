// @vitest-environment node

import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"

const mockPtySpawn = vi.hoisted(() => vi.fn())
const mockExecFileSync = vi.hoisted(() => vi.fn())

vi.mock("node-pty", () => ({ spawn: mockPtySpawn }))
vi.mock("node:child_process", () => ({ execFileSync: mockExecFileSync }))

import { PtySessionManager } from "../pty-server"

class FakeSocket extends EventEmitter {
  readonly sent: string[] = []
  readyState = WebSocket.OPEN

  send(message: string): void {
    this.sent.push(message)
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

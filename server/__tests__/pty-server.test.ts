// @vitest-environment node

import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"

const mockPtySpawn = vi.hoisted(() => vi.fn())

vi.mock("node-pty", () => ({ spawn: mockPtySpawn }))

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

describe("PtySessionManager", () => {
  beforeEach(() => {
    mockPtySpawn.mockReset()
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
})

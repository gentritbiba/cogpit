// @vitest-environment node
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"

import { connectDesktopShell, disconnectDesktopShellForTest, postToDesktopShell } from "../../lib/desktopShell"
import { parseShellMessage } from "../../../shared/desktopProtocol"

afterEach(() => {
  disconnectDesktopShellForTest()
  vi.restoreAllMocks()
})

function connect() {
  const input = new PassThrough()
  const output = new PassThrough()
  const handlers = { onMessage: vi.fn(), onShutdown: vi.fn() }
  connectDesktopShell(input, output, handlers)
  return { input, output, handlers }
}

/** readline delivers lines on a later tick. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

describe("parseShellMessage", () => {
  it("reads every message the shell sends", () => {
    expect(parseShellMessage('{"type":"desktop-presence","hasWindow":true,"locked":false,"idleSeconds":12.5}'))
      .toEqual({ type: "desktop-presence", hasWindow: true, locked: false, idleSeconds: 12.5 })
    expect(parseShellMessage('{"type":"notification-clicked","historyId":"h1"}'))
      .toEqual({ type: "notification-clicked", historyId: "h1" })
    expect(parseShellMessage('{"type":"shutdown"}')).toEqual({ type: "shutdown" })
  })

  it.each([
    ["not JSON", "hello"],
    ["not an object", "42"],
    ["an unknown type", '{"type":"reboot"}'],
    ["presence without idle time", '{"type":"desktop-presence","hasWindow":true,"locked":false}'],
    ["a click without a history id", '{"type":"notification-clicked"}'],
  ])("rejects %s", (_label, line) => {
    expect(parseShellMessage(line)).toBeNull()
  })
})

describe("connectDesktopShell", () => {
  it("passes the shell's messages on, one per line", async () => {
    const { input, handlers } = connect()
    input.write('{"type":"notification-clicked","historyId":"h1"}\n{"type":"desktop-presence","hasWindow":false,"locked":true,"idleSeconds":0}\r\n')
    await settle()
    expect(handlers.onMessage.mock.calls).toEqual([
      [{ type: "notification-clicked", historyId: "h1" }],
      [{ type: "desktop-presence", hasWindow: false, locked: true, idleSeconds: 0 }],
    ])
    expect(handlers.onShutdown).not.toHaveBeenCalled()
  })

  it("logs and skips a line it does not understand", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const { input, handlers } = connect()
    input.write("garbage\n\n")
    await settle()
    expect(handlers.onMessage).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledOnce()
  })

  it("shuts down once, whether asked to or because the shell went away", async () => {
    const { input, handlers } = connect()
    input.write('{"type":"shutdown"}\n')
    await settle()
    expect(handlers.onShutdown).toHaveBeenCalledOnce()
    input.end()
    await settle()
    expect(handlers.onShutdown).toHaveBeenCalledOnce()
  })

  it("shuts down when the shell closes its end", async () => {
    const { input, handlers } = connect()
    input.end()
    await settle()
    expect(handlers.onShutdown).toHaveBeenCalledOnce()
  })
})

describe("postToDesktopShell", () => {
  it("is false without a shell, so the caller uses its own fallback", () => {
    expect(postToDesktopShell({ type: "ready", port: 1 })).toBe(false)
  })

  it("writes one JSON line per message", () => {
    const { output } = connect()
    expect(postToDesktopShell({ type: "ready", port: 51234 })).toBe(true)
    expect(postToDesktopShell({ type: "error", error: "boom" })).toBe(true)
    expect(output.read().toString()).toBe('{"type":"ready","port":51234}\n{"type":"error","error":"boom"}\n')
  })
})

// @vitest-environment node
import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SlackApiError } from "../../slack/api"
import { SocketModeClient, type SocketLike } from "../../slack/socket"

class FakeSocket extends EventEmitter implements SocketLike {
  sent: unknown[] = []
  closed = false
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.closed = true }
  message(value: unknown) { this.emit("message", JSON.stringify(value)) }
}

function client(onEvent: (payload: Record<string, unknown>) => Promise<void> = async () => {}, appApi = vi.fn(async () => ({ ok: true, url: "wss://test" })), staleMs?: number) {
  const sockets: FakeSocket[] = []
  const socket = new SocketModeClient({ appApi, onEvent, staleMs, log: () => {}, connect: () => { const next = new FakeSocket(); sockets.push(next); return next } })
  return { socket, sockets, appApi }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

afterEach(() => vi.useRealTimers())

describe("SocketModeClient", () => {
  it("is connected after hello and acknowledges an event only once it is handled", async () => {
    let release!: () => void
    const handled = new Promise<void>((resolve) => { release = resolve })
    const { socket, sockets } = client(() => handled)
    socket.start()
    await flush()
    sockets[0].message({ type: "hello" })
    expect(socket.state).toBe("connected")
    sockets[0].message({ type: "events_api", envelope_id: "e1", payload: { event: { type: "message" } } })
    await flush()
    expect(sockets[0].sent).toEqual([])
    release()
    await flush()
    expect(sockets[0].sent).toEqual([{ envelope_id: "e1" }])
    socket.stop()
  })

  it("leaves an event unacknowledged when handling fails, so Slack resends it", async () => {
    const { socket, sockets } = client(async () => { throw new Error("disk full") })
    socket.start()
    await flush()
    sockets[0].message({ type: "events_api", envelope_id: "e1", payload: {} })
    await flush()
    expect(sockets[0].sent).toEqual([])
    socket.stop()
  })

  it("acknowledges envelopes it does not handle", async () => {
    const { socket, sockets } = client()
    socket.start()
    await flush()
    sockets[0].message({ type: "slash_commands", envelope_id: "e2", payload: {} })
    await flush()
    expect(sockets[0].sent).toEqual([{ envelope_id: "e2" }])
    socket.stop()
  })

  it("opens a fresh connection when Slack asks to reconnect or the socket closes", async () => {
    vi.useFakeTimers()
    const { socket, sockets, appApi } = client()
    socket.start()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].message({ type: "disconnect", reason: "refresh_requested" })
    expect(sockets[0].closed).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sockets).toHaveLength(2)
    sockets[1].emit("close")
    await vi.advanceTimersByTimeAsync(2000)
    expect(sockets).toHaveLength(3)
    expect(appApi).toHaveBeenCalledTimes(3)
    socket.stop()
  })

  it("replaces a connection that has gone silent", async () => {
    vi.useFakeTimers()
    const { socket, sockets } = client(undefined, undefined, 3000)
    socket.start()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].message({ type: "hello" })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sockets.length).toBeGreaterThan(1)
    socket.stop()
  })

  it("retries a connection that never says hello", async () => {
    vi.useFakeTimers()
    const { socket, sockets } = client(undefined, undefined, 3000)
    socket.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(socket.state).not.toBe("connected")
    expect(sockets.length).toBeGreaterThan(1)
    expect(sockets[0].closed).toBe(true)
    socket.stop()
  })

  it("stops for good on an invalid app token", async () => {
    const { socket } = client(undefined, vi.fn(async () => { throw new SlackApiError("apps.connections.open", "invalid_auth") }))
    socket.start()
    await flush()
    expect(socket.state).toBe("failed")
    expect(socket.lastError).toContain("invalid_auth")
  })
})

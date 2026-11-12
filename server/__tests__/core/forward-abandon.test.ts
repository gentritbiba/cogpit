// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createServer as createHttpServer, request, type IncomingMessage, type Server as HttpServer } from "node:http"
import { createServer, type AddressInfo, type Server, type Socket } from "node:net"

import { forwardToCore } from "../../core/forward"
import { whenCoreReady } from "../../core/supervisor"
import { MAX_REQUEST_BODY_BYTES } from "../../http"
import { bodySizeLimit } from "../../security"

vi.mock("../../core/supervisor", () => ({ whenCoreReady: vi.fn() }))

/**
 * What a stand-in core saw of one connection. It answers at once and keeps
 * writing until the forwarder closes its side, which is how it tells that a
 * request was abandoned.
 */
interface Seen {
  request: Buffer[]
  events: string[]
  /** It can write no more: nobody is reading its answer. */
  stalled: Promise<void>
  closed: Promise<void>
}

let core: Server
let front: HttpServer
let frontPort: number
let arrived: (seen: Seen) => void

/** The next connection the stand-in core accepts. */
function nextConnection(): Promise<Seen> {
  return new Promise((resolve) => { arrived = resolve })
}

beforeAll(async () => {
  core = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    const filler = Buffer.alloc(64 * 1024, 2)
    const frame = Buffer.concat([Buffer.from(`${filler.length.toString(16)}\r\n`), filler, Buffer.from("\r\n")])
    let quiet: NodeJS.Timeout | undefined
    let stalled!: () => void
    let closed!: () => void
    const seen: Seen = {
      request: [],
      events: [],
      stalled: new Promise((resolve) => { stalled = resolve }),
      closed: new Promise((resolve) => { closed = resolve }),
    }
    const { request: received, events } = seen
    arrived(seen)
    const flood = () => {
      clearTimeout(quiet)
      while (socket.writable && socket.write(frame)) { /* until it pushes back */ }
      quiet = setTimeout(stalled, 200)
    }
    socket.on("drain", flood)
    socket.once("data", () => {
      socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
      flood()
    })
    socket.on("data", (part: Buffer) => received.push(part))
    socket.on("end", () => {
      events.push("end")
      socket.end()
    })
    socket.on("error", (error: NodeJS.ErrnoException) => events.push(`error ${error.code}`))
    socket.on("close", () => {
      clearTimeout(quiet)
      closed()
    })
  })
  await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve))
  const { port } = core.address() as AddressInfo
  vi.mocked(whenCoreReady).mockResolvedValue({ port, secret: "secret", version: "test", pid: 0, origin: `http://127.0.0.1:${port}` })

  front = createHttpServer((req, res) => bodySizeLimit(req, res, () => void forwardToCore(req, res, "/v1/anything")))
  await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve))
  frontPort = (front.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => front.close(() => resolve()))
  await new Promise<void>((resolve) => core.close(() => resolve()))
})

describe("forwardToCore abandoning a request", () => {
  it("lets core see the request end when the client leaves mid-answer", async () => {
    const connection = nextConnection()
    const client = request({ host: "127.0.0.1", port: frontPort, path: "/", agent: false })
    client.on("error", () => {})
    // The answer is never read, so it backs up all the way to core.
    await new Promise((resolve) => client.once("response", resolve).end())
    const seen = await connection
    await seen.stalled
    client.destroy()
    await seen.closed
    expect(seen.events).toEqual(["end"])
  })

  it("never lets core take a refused body for a whole one", async () => {
    const chunk = Buffer.alloc(512 * 1024, 1)
    const connection = nextConnection()
    const client = request({ host: "127.0.0.1", port: frontPort, path: "/", method: "POST", agent: false })
    client.on("error", () => {})
    // Core has answered before the body crosses the limit, so the answer is cut, not replaced by a 413.
    client.write(chunk)
    const answer = await new Promise<IncomingMessage>((resolve) => client.once("response", resolve))
    answer.on("error", () => {}).resume()
    for (let sent = chunk.length; sent <= MAX_REQUEST_BODY_BYTES; sent += chunk.length) client.write(chunk)
    client.end()
    const seen = await connection
    await seen.closed
    expect(seen.events).toEqual(["end"])
    const received = Buffer.concat(seen.request)
    expect(received.length).toBeGreaterThan(MAX_REQUEST_BODY_BYTES / 2)
    expect(received.subarray(-5).toString()).not.toBe("0\r\n\r\n")
  })
})

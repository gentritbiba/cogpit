import { describe, it, expect, vi } from "vitest"
import { EventEmitter } from "node:events"
import type { IncomingMessage, ServerResponse } from "node:http"
import { withJsonBody } from "../http"

function fakeReq() {
  return new EventEmitter() as unknown as IncomingMessage
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: vi.fn(),
    end: vi.fn(() => {
      res.headersSent = true
    }),
  }
  return res as unknown as ServerResponse & { end: ReturnType<typeof vi.fn> }
}

function send(req: IncomingMessage, ...chunks: string[]) {
  for (const chunk of chunks) req.emit("data", Buffer.from(chunk))
  req.emit("end")
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("withJsonBody", () => {
  it("hands the parsed body to the handler", async () => {
    const req = fakeReq()
    const res = fakeRes()
    const handler = vi.fn()

    withJsonBody(req, res, handler)
    send(req, '{"a":1}')
    await flush()

    expect(handler).toHaveBeenCalledWith({ a: 1 })
  })

  it("rejects a malformed body without reaching the handler", async () => {
    const req = fakeReq()
    const res = fakeRes()
    const handler = vi.fn()

    withJsonBody(req, res, handler)
    send(req, "not json")
    await flush()

    expect(handler).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(400)
  })

  it("bounds the body, which the hand-rolled readers never did", async () => {
    const req = fakeReq()
    const res = fakeRes()
    const handler = vi.fn()

    withJsonBody(req, res, handler, { maxBytes: 8 })
    send(req, '{"a":"paddingpaddingpadding"}')
    await flush()

    expect(handler).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(413)
  })

  it("rejoins a multi-byte character split across chunks", async () => {
    const req = fakeReq()
    const res = fakeRes()
    const handler = vi.fn()
    const encoded = Buffer.from('{"t":"é"}')

    withJsonBody(req, res, handler)
    req.emit("data", encoded.subarray(0, 7))
    req.emit("data", encoded.subarray(7))
    req.emit("end")
    await flush()

    expect(handler).toHaveBeenCalledWith({ t: "é" })
  })

  it("does not answer twice when the handler already responded", async () => {
    const req = fakeReq()
    const res = fakeRes()

    withJsonBody(req, res, () => {
      res.end("done")
      throw new Error("late failure")
    })
    send(req, "{}")
    await flush()

    expect(res.end).toHaveBeenCalledTimes(1)
  })

  it("reports a handler that fails before responding", async () => {
    const req = fakeReq()
    const res = fakeRes()

    withJsonBody(req, res, () => {
      throw new Error("boom")
    })
    send(req, "{}")
    await flush()

    expect(res.statusCode).toBe(500)
  })
})

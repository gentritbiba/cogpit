// @vitest-environment node
import { Readable } from "node:stream"
import { describe, expect, it, vi } from "vitest"

import {
  catchAsyncErrors,
  HttpBodyError,
  readJsonBody,
  sendJson,
} from "../http"
import { sendJson as compatibilitySendJson } from "../helpers"

describe("sendJson", () => {
  it("sets the status and JSON content type, serializes once, and ends the response", () => {
    const payload = { ok: true, nested: { count: 2 } }
    const response = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn(),
    }

    sendJson(response as never, 202, payload)

    expect(response.statusCode).toBe(202)
    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "application/json")
    expect(response.end).toHaveBeenCalledOnce()
    expect(response.end).toHaveBeenCalledWith(JSON.stringify(payload))
  })

  it("remains available through the helpers compatibility barrel", () => {
    expect(compatibilitySendJson).toBe(sendJson)
  })
})

describe("catchAsyncErrors", () => {
  it.each([
    ["synchronous", () => { throw new Error("sync failure") }],
    ["asynchronous", async () => { throw new Error("async failure") }],
  ])("forwards %s middleware failures to next", async (_kind, handler) => {
    const next = vi.fn()
    const wrapped = catchAsyncErrors(handler)

    wrapped({} as never, {} as never, next)

    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce())
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error)
  })
})

describe("readJsonBody", () => {
  it("parses JSON split across request chunks", async () => {
    const request = Readable.from([Buffer.from('{"count":'), Buffer.from("2}")])

    await expect(readJsonBody<{ count: number }>(request as never)).resolves.toEqual({ count: 2 })
  })

  it("optionally treats an empty request as an empty object", async () => {
    const request = Readable.from([])

    await expect(readJsonBody(request as never, { allowEmpty: true })).resolves.toEqual({})
  })

  it("rejects invalid JSON with a typed client error", async () => {
    const request = Readable.from(["not-json"])

    await expect(readJsonBody(request as never)).rejects.toMatchObject({
      name: HttpBodyError.name,
      message: "Invalid JSON body",
      statusCode: 400,
    })
  })

  it("rejects a request as soon as its byte limit is exceeded", async () => {
    const request = Readable.from(["123", "45"])

    await expect(readJsonBody(request as never, { maxBytes: 4 })).rejects.toMatchObject({
      name: HttpBodyError.name,
      message: "Request body too large",
      statusCode: 413,
    })
  })
})

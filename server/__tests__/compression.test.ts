// @vitest-environment node
import { describe, it, expect } from "vitest"
import { gunzipSync } from "node:zlib"
import type { IncomingMessage, ServerResponse } from "node:http"
import { compressionMiddleware } from "../compression"

interface MockRes extends ServerResponse {
  _headers: Map<string, string | number>
  _ended: Promise<{ body: Buffer | null }>
  _writes: unknown[]
}

function createRes(): MockRes {
  const headers = new Map<string, string | number>()
  const writes: unknown[] = []
  let resolveEnd: (v: { body: Buffer | null }) => void
  const ended = new Promise<{ body: Buffer | null }>((resolve) => {
    resolveEnd = resolve
  })
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(name: string, value: string | number) {
      headers.set(name.toLowerCase(), value)
      return res
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase())
    },
    removeHeader(name: string) {
      headers.delete(name.toLowerCase())
    },
    write(chunk: unknown) {
      writes.push(chunk)
      return true
    },
    end(chunk?: unknown, encoding?: unknown, callback?: unknown) {
      res.headersSent = true
      const body =
        typeof chunk === "string" ? Buffer.from(chunk)
        : Buffer.isBuffer(chunk) ? chunk
        : null
      resolveEnd({ body })
      if (typeof encoding === "function") (encoding as () => void)()
      else if (typeof callback === "function") (callback as () => void)()
      return res
    },
    _headers: headers,
    _ended: ended,
    _writes: writes,
  }
  return res as unknown as MockRes
}

function runMiddleware(
  res: MockRes,
  reqHeaders: Record<string, string> = { "accept-encoding": "gzip, deflate, br" },
  method = "GET",
): boolean {
  let nextCalled = false
  compressionMiddleware(
    { method, headers: reqHeaders, url: "/api/test" } as unknown as IncomingMessage,
    res,
    () => {
      nextCalled = true
    },
  )
  return nextCalled
}

const LARGE_JSON = JSON.stringify({ data: "x".repeat(4096) })
const SMALL_JSON = JSON.stringify({ ok: true })

describe("compressionMiddleware", () => {
  it("gzips large JSON responses when the client accepts gzip", async () => {
    const res = createRes()
    expect(runMiddleware(res)).toBe(true)

    res.setHeader("Content-Type", "application/json")
    res.end(LARGE_JSON)

    const { body } = await res._ended
    expect(res._headers.get("content-encoding")).toBe("gzip")
    expect(res._headers.get("vary")).toBe("Accept-Encoding")
    expect(body).not.toBeNull()
    expect(body!.byteLength).toBeLessThan(Buffer.byteLength(LARGE_JSON))
    expect(Number(res._headers.get("content-length"))).toBe(body!.byteLength)
    expect(gunzipSync(body!).toString()).toBe(LARGE_JSON)
  })

  it("gzips large Buffer bodies", async () => {
    const res = createRes()
    runMiddleware(res)

    res.setHeader("Content-Type", "text/plain")
    res.end(Buffer.from(LARGE_JSON))

    const { body } = await res._ended
    expect(res._headers.get("content-encoding")).toBe("gzip")
    expect(gunzipSync(body!).toString()).toBe(LARGE_JSON)
  })

  it("leaves small responses uncompressed", async () => {
    const res = createRes()
    runMiddleware(res)

    res.setHeader("Content-Type", "application/json")
    res.end(SMALL_JSON)

    const { body } = await res._ended
    expect(res._headers.get("content-encoding")).toBeUndefined()
    expect(body!.toString()).toBe(SMALL_JSON)
  })

  it("does nothing when the client does not accept gzip", async () => {
    const res = createRes()
    expect(runMiddleware(res, {})).toBe(true)

    res.setHeader("Content-Type", "application/json")
    res.end(LARGE_JSON)

    const { body } = await res._ended
    expect(res._headers.get("content-encoding")).toBeUndefined()
    expect(body!.toString()).toBe(LARGE_JSON)
  })

  it("respects gzip;q=0 as a refusal", async () => {
    const res = createRes()
    runMiddleware(res, { "accept-encoding": "gzip;q=0, identity" })

    res.setHeader("Content-Type", "application/json")
    res.end(LARGE_JSON)

    const { body } = await res._ended
    expect(res._headers.get("content-encoding")).toBeUndefined()
    expect(body!.toString()).toBe(LARGE_JSON)
  })

  it("bypasses streaming responses that used res.write (SSE)", async () => {
    const res = createRes()
    runMiddleware(res)

    res.setHeader("Content-Type", "text/event-stream")
    res.write("data: hello\n\n")
    res.end()

    const { body } = await res._ended
    expect(res._writes).toEqual(["data: hello\n\n"])
    expect(res._headers.get("content-encoding")).toBeUndefined()
    expect(body).toBeNull()
  })

  it("skips non-compressible content types", async () => {
    const res = createRes()
    runMiddleware(res)

    res.setHeader("Content-Type", "application/octet-stream")
    res.end(Buffer.from(LARGE_JSON))

    const { body } = await res._ended
    expect(res._headers.get("content-encoding")).toBeUndefined()
    expect(body!.toString()).toBe(LARGE_JSON)
  })

  it("skips responses that already have a Content-Encoding", async () => {
    const res = createRes()
    runMiddleware(res)

    res.setHeader("Content-Type", "application/json")
    res.setHeader("Content-Encoding", "br")
    res.end(LARGE_JSON)

    const { body } = await res._ended
    expect(res._headers.get("content-encoding")).toBe("br")
    expect(body!.toString()).toBe(LARGE_JSON)
  })

  it("invokes the end callback after compressed send", async () => {
    const res = createRes()
    runMiddleware(res)

    res.setHeader("Content-Type", "application/json")
    let called = false
    res.end(LARGE_JSON, () => {
      called = true
    })

    await res._ended
    expect(called).toBe(true)
  })

  it("skips HEAD requests entirely", async () => {
    const res = createRes()
    expect(runMiddleware(res, { "accept-encoding": "gzip" }, "HEAD")).toBe(true)

    res.setHeader("Content-Type", "application/json")
    res.end(LARGE_JSON)

    const { body } = await res._ended
    expect(res._headers.get("content-encoding")).toBeUndefined()
    expect(body!.toString()).toBe(LARGE_JSON)
  })
})

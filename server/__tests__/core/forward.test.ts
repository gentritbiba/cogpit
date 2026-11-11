// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import express from "express"
import { createServer, request, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"

import { forwardToCore } from "../../core/forward"
import { CORE_SECRET_HEADER } from "../../core/protocol"
import { startCore, type CoreLease } from "../../core/supervisor"
import { MAX_REQUEST_BODY_BYTES } from "../../http"
import { setRequestPrincipal } from "../../requestPrincipal"
import { bodySizeLimit } from "../../security"

let core: CoreLease
let server: Server
let origin: string

beforeAll(async () => {
  core = await startCore({ dataDir: tmpdir() })
  const app = express()
  app.use(bodySizeLimit)
  app.use((req, _res, next) => {
    if (req.headers["x-test-user"]) {
      setRequestPrincipal(req, { userId: String(req.headers["x-test-user"]), username: "u", role: "member" })
    }
    next()
  })
  app.use("/api/echo", (req, res) => void forwardToCore(req, res, "/v1/diag/echo"))
  app.use("/api/drain", (req, res) => void forwardToCore(req, res, "/v1/diag/drain"))
  app.use("/api/missing", (req, res) => void forwardToCore(req, res, "/v1/nothing"))
  server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await core.release()
})

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

/**
 * Sends `chunks` with chunked encoding, one write per chunk, and stops
 * writing once the server refuses it. A reply wins over a write error, since a
 * server refusing a body may close the connection while the client still sends.
 */
function send(path: string, { method = "POST", chunks = [] as Buffer[], headers = {} as Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let answered = false
    let answeredStatus = 0
    const req = request(`${origin}${path}`, { method, headers, agent: false }, (res) => {
      answered = true
      answeredStatus = res.statusCode ?? 0
      const parts: Buffer[] = []
      res.on("data", (part: Buffer) => parts.push(part))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }))
      res.on("error", reject)
    })
    req.on("error", (error) => {
      if (!answered) reject(error)
    })
    void (async () => {
      for (const chunk of chunks) {
        if ((answered && answeredStatus >= 400) || req.destroyed) return
        if (!req.write(chunk)) await new Promise((drained) => req.once("drain", drained))
      }
      req.end()
    })()
  })
}

describe("forwardToCore", () => {
  it("rebuilds the core path from the original URL, keeping the query string", async () => {
    const reply = await send("/api/echo/ignored/tail?path=%2Ftmp%2Fa%20b.png&x=1", { method: "GET" })
    expect(reply.status).toBe(200)
    expect(reply.headers["x-core-method"]).toBe("GET")
    expect(reply.headers["x-core-path"]).toBe("/v1/diag/echo?path=%2Ftmp%2Fa%20b.png&x=1")
  })

  it("streams a chunked body to core and the response back", async () => {
    const chunks = Array.from({ length: 64 }, (_, index) => Buffer.alloc(32 * 1024, index))
    const reply = await send("/api/echo", { chunks, headers: { "content-type": "application/octet-stream" } })
    expect(reply.status).toBe(200)
    expect(reply.headers["content-type"]).toBe("application/octet-stream")
    expect(reply.body.equals(Buffer.concat(chunks))).toBe(true)
  })

  it("passes the principal for logging and never a client's own secret or principal", async () => {
    const reply = await send("/api/echo", {
      method: "GET",
      headers: { "x-test-user": "user 7", [CORE_SECRET_HEADER]: "forged", "x-cogpit-principal": "admin" },
    })
    expect(reply.status).toBe(200)
    expect(reply.headers["x-core-principal"]).toBe("user%207")
    const anonymous = await send("/api/echo", { method: "GET", headers: { "x-cogpit-principal": "admin" } })
    expect(anonymous.headers["x-core-principal"]).toBe("")
  })

  it("relays core's status codes", async () => {
    expect((await send("/api/missing", { method: "GET" })).status).toBe(404)
  })

  it("leaves an oversized declared body to bodySizeLimit", async () => {
    const reply = await send("/api/echo", { headers: { "content-length": String(MAX_REQUEST_BODY_BYTES + 1) } })
      .catch(() => null)
    if (reply) expect(reply.status).toBe(413)
  })

  it("lets bodySizeLimit answer 413 when a chunked body grows too large mid-request", async () => {
    const chunk = Buffer.alloc(512 * 1024, 1)
    const oversized = Array.from({ length: Math.ceil(MAX_REQUEST_BODY_BYTES / chunk.length) + 2 }, () => chunk)
    const reply = await send("/api/drain", { chunks: oversized }).catch(() => null)
    // The server may cut the upload before the client reads the answer; when
    // it does get through, it is the limit's 413, never core's.
    if (reply) {
      expect(reply.status).toBe(413)
      expect(JSON.parse(reply.body.toString())).toEqual({ error: "Request body too large" })
    }
    const fits = await send("/api/drain", { chunks: [chunk, chunk] })
    expect(JSON.parse(fits.body.toString())).toEqual({ bytes: 2 * chunk.length })
  })

  it("cuts a response core already started when the body then grows too large", async () => {
    const chunk = Buffer.alloc(512 * 1024, 1)
    const oversized = Array.from({ length: Math.ceil(MAX_REQUEST_BODY_BYTES / chunk.length) + 2 }, () => chunk)
    const reply = await send("/api/echo", { chunks: oversized }).catch((error: Error) => error)
    if (!(reply instanceof Error)) expect(reply.body.length).toBeLessThan(MAX_REQUEST_BODY_BYTES + chunk.length)
    const after = await send("/api/echo", { chunks: [Buffer.from("still here")] })
    expect(after.body.toString()).toBe("still here")
  })
})

describe("forwardToCore without a core", () => {
  it("answers 503", async () => {
    await core.release()
    try {
      const reply = await send("/api/echo", { method: "GET" })
      expect(reply.status).toBe(503)
      expect(JSON.parse(reply.body.toString())).toEqual({ error: "Cogpit core is not running" })
    } finally {
      core = await startCore({ dataDir: tmpdir() })
    }
  })
})

// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import { request as httpsRequest } from "node:https"
import { EventEmitter } from "node:events"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WebSocketServer, WebSocket } from "ws"

import { createHubProxyHandler, handleHubUpgrade } from "../../hub/proxy"
import { initDeviceRegistry, addDevice, type HubDevice } from "../../hub/registry"
import { getConfig } from "../../config"
import { createSessionToken, revokeAllSessions } from "../../security"

// TLS devices must route through node:https. A real https upstream would need
// a trusted cert (validation is deliberately strict), so the https module is
// mocked; the http-based e2e tests below never touch it.
vi.mock("node:https", () => ({ request: vi.fn() }))
const mockedHttpsRequest = vi.mocked(httpsRequest)

// getConfig gates the hub-side WS upgrade auth for remote clients. Local e2e
// tests connect over loopback and skip it entirely; only the auth-branch tests
// below read it, so they set the return value explicitly.
vi.mock("../../config", () => ({ getConfig: vi.fn() }))
const mockedGetConfig = vi.mocked(getConfig)

// ── Test target device ───────────────────────────────────────────────
//
// A REAL http server standing in for a remote Cogpit device. It implements
// `/api/auth/verify` (so the real device-client mints against it) and forwards
// every other request to a per-test `respond` callback that receives the fully
// buffered body — proving the proxy actually pipes/replays real bytes.

interface TargetRequest {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: Buffer
}

type Responder = (req: IncomingMessage, res: ServerResponse, r: TargetRequest, target: Target) => void

interface Target {
  port: number
  requests: TargetRequest[]
  mintTokens: string[]
  get mintCount(): number
  respond: Responder
  server: http.Server
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
  })
}

async function makeTarget(respond: Responder): Promise<Target> {
  const requests: TargetRequest[] = []
  const mintTokens: string[] = []

  const target = {
    requests,
    mintTokens,
    get mintCount() {
      return mintTokens.length
    },
    respond,
  } as Target

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const body = Buffer.concat(chunks)
      if (req.url === "/api/auth/verify" && req.method === "POST") {
        const token = `tok-${mintTokens.length + 1}`
        mintTokens.push(token)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ valid: true, token }))
        return
      }
      const record: TargetRequest = { method: req.method || "", url: req.url || "", headers: req.headers, body }
      requests.push(record)
      target.respond(req, res, record, target)
    })
  })

  target.server = server
  target.port = await listen(server)
  return target
}

// ── Hub server mounting the proxy handler ────────────────────────────

const handler = createHubProxyHandler()
let sawSpaFallback = false

async function makeHub(): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer((req, res) => {
    // Emulate the mount strip that `use("/hub", handler)` performs in both shells.
    if (req.url?.startsWith("/hub")) req.url = req.url.slice("/hub".length) || "/"
    handler(req, res, () => {
      // The proxy must never fall through to the SPA fallback for hub paths.
      sawSpaFallback = true
      res.statusCode = 599
      res.end("SPA_FALLBACK")
    })
  })
  server.on("upgrade", (req, socket, head) => {
    if (!handleHubUpgrade(req, socket, head)) socket.destroy()
  })
  const port = await listen(server)
  return { port, server }
}

// ── Lifecycle ────────────────────────────────────────────────────────

let registryDir: string
const openServers: http.Server[] = []

function track<T extends { server: http.Server }>(x: T): T {
  openServers.push(x.server)
  return x
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

beforeAll(async () => {
  registryDir = await mkdtemp(join(tmpdir(), "cogpit-proxy-"))
  await initDeviceRegistry(registryDir)
})

afterAll(async () => {
  await rm(registryDir, { recursive: true, force: true })
})

afterEach(async () => {
  sawSpaFallback = false
  await Promise.all(openServers.splice(0).map(closeServer))
})

// ── Convenience ──────────────────────────────────────────────────────

async function passwordDevice(port: number, name = "Studio"): Promise<HubDevice> {
  return addDevice({ name, host: "127.0.0.1", port, auth: "password", password: "hunter2secret1" })
}

const base = (hubPort: number, deviceId: string, rest: string) => `http://127.0.0.1:${hubPort}/hub/${deviceId}${rest}`

// ── Tests ────────────────────────────────────────────────────────────

describe("createHubProxyHandler — request rewriting", () => {
  it("strips the hub token query param, injects the device Bearer token, and drops the client Authorization", async () => {
    const target = track(await makeTarget((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    }))
    const device = await passwordDevice(target.port)
    const hub = track(await makeHub())

    const res = await fetch(base(hub.port, device.id, "/api/echo?keep=1&token=HUBSECRET&other=two"), {
      headers: { Authorization: "Bearer CLIENT_HUB_TOKEN", "x-cogpit-client": "1" },
    })
    expect(res.status).toBe(200)
    expect(sawSpaFallback).toBe(false)

    const seen = target.requests.at(-1)!
    // token removed, every other param + order + encoding preserved.
    expect(seen.url).toBe("/api/echo?keep=1&other=two")
    // device token injected, client hub token never forwarded.
    expect(seen.headers.authorization).toMatch(/^Bearer tok-\d+$/)
    expect(seen.headers.authorization).not.toContain("CLIENT_HUB_TOKEN")
  })

  it("does not forward the hub cookie or browser-origin metadata to a device", async () => {
    const target = track(await makeTarget((_req, res) => res.end("ok")))
    const device = await passwordDevice(target.port)
    const hub = track(await makeHub())

    const res = await fetch(base(hub.port, device.id, "/api/echo"), {
      headers: {
        Cookie: "__Host-cogpit_session=HUB_SECRET",
        Origin: `http://127.0.0.1:${hub.port}`,
        Referer: `http://127.0.0.1:${hub.port}/dashboard`,
        "Sec-Fetch-Site": "same-origin",
      },
    })
    expect(res.status).toBe(200)

    const seen = target.requests.at(-1)!
    expect(seen.headers.cookie).toBeUndefined()
    expect(seen.headers.origin).toBeUndefined()
    expect(seen.headers.referer).toBeUndefined()
    expect(seen.headers["sec-fetch-site"]).toBeUndefined()
  })

  it("strips Set-Cookie from downstream device responses", async () => {
    const target = track(await makeTarget((_req, res) => {
      res.writeHead(200, { "Set-Cookie": "__Host-cogpit_session=DEVICE_TOKEN; Path=/; Secure" })
      res.end("ok")
    }))
    const device = await passwordDevice(target.port)
    const hub = track(await makeHub())

    const res = await fetch(base(hub.port, device.id, "/api/thing"))
    expect(res.status).toBe(200)
    expect(res.headers.get("set-cookie")).toBeNull()
  })

  it("stamps X-Cogpit-Device on a successful response", async () => {
    const target = track(await makeTarget((_req, res) => res.end("ok")))
    const device = await passwordDevice(target.port)
    const hub = track(await makeHub())

    const res = await fetch(base(hub.port, device.id, "/api/thing"))
    expect(res.status).toBe(200)
    expect(res.headers.get("x-cogpit-device")).toBe(device.id)
  })
})

describe("createHubProxyHandler — routing guards", () => {
  it("returns a JSON 404 UNKNOWN_DEVICE for an unregistered device (never SPA)", async () => {
    const hub = track(await makeHub())
    const res = await fetch(base(hub.port, "dev_missing", "/api/x"))
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: "UNKNOWN_DEVICE" })
    expect(sawSpaFallback).toBe(false)
  })

  it("returns a JSON 404 BAD_HUB_PATH when the rest does not target /api/*", async () => {
    const target = track(await makeTarget((_req, res) => res.end("ok")))
    const device = await passwordDevice(target.port)
    const hub = track(await makeHub())

    const res = await fetch(base(hub.port, device.id, "/notapi/x"))
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: "BAD_HUB_PATH" })
    expect(res.headers.get("x-cogpit-device")).toBe(device.id)
    // Never proxied to the device, never fell through to the SPA.
    expect(target.requests).toHaveLength(0)
    expect(sawSpaFallback).toBe(false)
  })

  it("blocks /hub/x/hub/y recursion via BAD_HUB_PATH", async () => {
    const target = track(await makeTarget((_req, res) => res.end("ok")))
    const device = await passwordDevice(target.port)
    const hub = track(await makeHub())

    const res = await fetch(base(hub.port, device.id, `/hub/${device.id}/api/x`))
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: "BAD_HUB_PATH" })
  })

  it("rejects a non-GET/HEAD request without X-Cogpit-Client (403, no proxy, no mint)", async () => {
    const target = track(await makeTarget((_req, res) => res.end("ok")))
    const device = await passwordDevice(target.port)
    const hub = track(await makeHub())

    const res = await fetch(base(hub.port, device.id, "/api/x"), { method: "POST", body: "payload" })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "MISSING_CLIENT_HEADER" })
    expect(target.requests).toHaveLength(0)
    expect(target.mintCount).toBe(0)
  })
})

describe("createHubProxyHandler — device auth failures", () => {
  it("re-mints once and replays the buffered POST body after a device 401", async () => {
    let proxied = 0
    const target = track(await makeTarget((_req, res, r) => {
      proxied += 1
      if (proxied === 1) {
        // First attempt: pretend the token is stale.
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "expired" }))
        return
      }
      // Second attempt (after re-mint): echo the body back so the test can prove
      // the buffered request was replayed byte-for-byte.
      res.writeHead(200, { "Content-Type": "application/json", "x-attempt-auth": String(r.headers.authorization) })
      res.end(r.body)
    }))
    const device = await passwordDevice(target.port)
    const hub = track(await makeHub())

    const payload = JSON.stringify({ message: "hold the door", n: 42 })
    const res = await fetch(base(hub.port, device.id, "/api/send"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-cogpit-client": "1" },
      body: payload,
    })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe(payload) // replayed body intact
    expect(proxied).toBe(2)
    expect(target.mintCount).toBe(2) // initial mint + one re-mint
    // The replay carried the freshly minted (second) token.
    expect(res.headers.get("x-attempt-auth")).toBe(`Bearer ${target.mintTokens[1]}`)
    expect(target.mintTokens[1]).not.toBe(target.mintTokens[0])
  })

  it("maps a persistent device 401 to a 502 DEVICE_AUTH_FAILED (never leaks 401 to the browser)", async () => {
    const target = track(await makeTarget((_req, res) => {
      res.writeHead(401)
      res.end("nope")
    }))
    const device = await passwordDevice(target.port)
    const hub = track(await makeHub())

    const res = await fetch(base(hub.port, device.id, "/api/x"))
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ code: "DEVICE_AUTH_FAILED" })
    expect(res.headers.get("x-cogpit-device")).toBe(device.id)
    expect(target.mintCount).toBe(2) // one re-mint attempt, then gives up
  })

  it("maps an unreachable device to a 502 DEVICE_UNREACHABLE", async () => {
    // Grab a port then free it so the connection is refused.
    const throwaway = http.createServer()
    const deadPort = await listen(throwaway)
    await closeServer(throwaway)

    const device = await addDevice({ name: "Dead", host: "127.0.0.1", port: deadPort, auth: "password", password: "hunter2secret1" })
    const hub = track(await makeHub())

    const res = await fetch(base(hub.port, device.id, "/api/x"))
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ code: "DEVICE_UNREACHABLE" })
    expect(res.headers.get("x-cogpit-device")).toBe(device.id)
  })
})

describe("createHubProxyHandler — streaming", () => {
  it("passes SSE chunks through raw, flushing the first chunk before the second is written", async () => {
    const target = track(await makeTarget((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      res.write("AAA")
      setTimeout(() => res.write("BBB"), 200)
      setTimeout(() => res.end(), 300)
    }))
    const device = await passwordDevice(target.port)
    const hub = track(await makeHub())

    const res = await fetch(base(hub.port, device.id, "/api/stream"))
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    const first = await reader.read()
    const firstText = decoder.decode(first.value)
    // A buffering proxy would only deliver anything at stream end; a raw pipe
    // hands us "AAA" immediately, well before "BBB" is even written.
    expect(firstText).toContain("AAA")
    expect(firstText).not.toContain("BBB")

    let rest = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rest += decoder.decode(value)
    }
    expect(rest).toContain("BBB")
  })

  it("passes non-401 error statuses (503) through verbatim", async () => {
    const target = track(await makeTarget((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "busy" }))
    }))
    const device = await passwordDevice(target.port)
    const hub = track(await makeHub())

    const res = await fetch(base(hub.port, device.id, "/api/x"))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: "busy" })
    expect(res.headers.get("x-cogpit-device")).toBe(device.id)
  })
})

describe("handleHubUpgrade", () => {
  it("returns false for a non-hub-pty upgrade path", () => {
    const req = { url: "/__pty", headers: {}, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage
    const fakeSocket = { write: () => {}, destroy: () => {}, destroyed: false } as never
    expect(handleHubUpgrade(req, fakeSocket, Buffer.alloc(0))).toBe(false)
  })

  it("proxies a WebSocket upgrade end-to-end to the device (auth:none local tunnel)", async () => {
    // Device-side WS server accepting /__pty and echoing messages.
    const wss = new WebSocketServer({ noServer: true })
    wss.on("connection", (ws) => {
      ws.on("message", (m) => ws.send(`echo:${m}`))
    })
    let deviceUpgradeHeaders: http.IncomingHttpHeaders | null = null
    const targetServer = http.createServer((_req, res) => res.end())
    targetServer.on("upgrade", (req, socket, head) => {
      deviceUpgradeHeaders = req.headers
      const u = new URL(req.url || "/", "http://localhost")
      if (u.pathname === "/__pty") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
      else socket.destroy()
    })
    openServers.push(targetServer)
    const targetPort = await listen(targetServer)

    const device = await addDevice({ name: "Tunnel", host: "127.0.0.1", port: targetPort, auth: "none" })
    const hub = track(await makeHub())

    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/hub/${device.id}/__pty`, {
      headers: {
        Cookie: "__Host-cogpit_session=HUB_SECRET",
        Origin: `http://127.0.0.1:${hub.port}`,
      },
    })
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve())
        ws.once("error", reject)
      })
      const reply = await new Promise<string>((resolve) => {
        ws.once("message", (d) => resolve(d.toString()))
        ws.send("ping")
      })
      expect(reply).toBe("echo:ping")
      const forwardedHeaders = deviceUpgradeHeaders as unknown as http.IncomingHttpHeaders
      expect(forwardedHeaders.cookie).toBeUndefined()
      expect(forwardedHeaders.origin).toBeUndefined()
    } finally {
      ws.close()
      wss.close()
    }
  })

  it("strips a downstream Set-Cookie header from the WebSocket handshake", async () => {
    const wss = new WebSocketServer({ noServer: true })
    wss.on("headers", (headers) => {
      headers.push("Set-Cookie: __Host-cogpit_session=DEVICE_TOKEN; Path=/; Secure")
    })
    const targetServer = http.createServer((_req, res) => res.end())
    targetServer.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
    })
    openServers.push(targetServer)
    const targetPort = await listen(targetServer)

    const device = await addDevice({
      name: "Cookie Tunnel",
      host: "127.0.0.1",
      port: targetPort,
      auth: "none",
    })
    const hub = track(await makeHub())
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/hub/${device.id}/__pty`)

    try {
      const upgradeHeaders = new Promise<http.IncomingHttpHeaders>((resolve) => {
        ws.once("upgrade", (response) => resolve(response.headers))
      })
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve())
        ws.once("error", reject)
      })

      const headers = await upgradeHeaders
      expect(headers["set-cookie"]).toBeUndefined()
      expect(headers["sec-websocket-accept"]).toBeTypeOf("string")
    } finally {
      ws.close()
      wss.close()
    }
  })

  it("re-mints the device token after a 401 upgrade and completes the handshake (password device)", async () => {
    // Device WS server echoing messages, plus a verify endpoint that hands out a
    // fresh token each call and an upgrade handler that 401s the FIRST attempt.
    const wss = new WebSocketServer({ noServer: true })
    wss.on("connection", (ws) => {
      ws.on("message", (m) => ws.send(`echo:${m}`))
    })

    const mintTokens: string[] = []
    let upgradeAttempts = 0
    const targetServer = http.createServer((req, res) => {
      if (req.url === "/api/auth/verify" && req.method === "POST") {
        const token = `tok-${mintTokens.length + 1}`
        mintTokens.push(token)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ valid: true, token }))
        return
      }
      res.end()
    })
    targetServer.on("upgrade", (req, socket, head) => {
      upgradeAttempts += 1
      if (upgradeAttempts === 1) {
        // Stale token → reject; forces a single re-mint + replay of the upgrade.
        socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
        return
      }
      const u = new URL(req.url || "/", "http://localhost")
      if (u.pathname === "/__pty") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
      else socket.destroy()
    })
    openServers.push(targetServer)
    const targetPort = await listen(targetServer)

    const device = await addDevice({
      name: "Studio", host: "127.0.0.1", port: targetPort, auth: "password", password: "hunter2secret1",
    })
    const hub = track(await makeHub())

    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/hub/${device.id}/__pty`)
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve())
        ws.once("error", reject)
      })
      const reply = await new Promise<string>((resolve) => {
        ws.once("message", (d) => resolve(d.toString()))
        ws.send("ping")
      })
      expect(reply).toBe("echo:ping")
      // Initial mint before the first upgrade + one re-mint after the 401.
      expect(mintTokens.length).toBe(2)
    } finally {
      ws.close()
      wss.close()
    }
  })
})

// ── Hub-side upgrade auth (remote clients) ───────────────────────────────
//
// The /hub/:id/__pty upgrade must enforce the same token check as /__pty for
// remote clients: no valid session token → 401, before any device is touched.

describe("handleHubUpgrade — hub-side auth", () => {
  beforeEach(() => {
    revokeAllSessions()
    // networkAccess must be on, else the branch short-circuits to 401 before the
    // token check (mirrors security.test.ts).
    mockedGetConfig.mockReturnValue({
      claudeDir: "/tmp/claude",
      networkAccess: true,
      networkPassword: "$sha256$abc:def",
    } as never)
  })

  function fakeUpgrade(url: string, ip = "192.168.1.50") {
    const writes: string[] = []
    let destroyed = false
    const socket = {
      write: (chunk: string | Buffer) => { writes.push(chunk.toString()); return true },
      end: (chunk?: string | Buffer) => { if (chunk) writes.push(chunk.toString()); destroyed = true },
      destroy: () => { destroyed = true },
      get destroyed() { return destroyed },
    } as never
    const req = { url, headers: {}, socket: { remoteAddress: ip } } as unknown as IncomingMessage
    return { req, socket, writes, isDestroyed: () => destroyed }
  }

  it("writes 401 and owns the socket for a remote upgrade with no token", () => {
    const { req, socket, writes, isDestroyed } = fakeUpgrade("/hub/dev_x/__pty")
    const owned = handleHubUpgrade(req, socket, Buffer.alloc(0))
    expect(owned).toBe(true)
    expect(writes.join("")).toContain("HTTP/1.1 401")
    expect(isDestroyed()).toBe(true)
  })

  it("writes 401 for a remote upgrade carrying an invalid token", () => {
    const { req, socket, writes } = fakeUpgrade("/hub/dev_x/__pty?token=not-a-real-token")
    expect(handleHubUpgrade(req, socket, Buffer.alloc(0))).toBe(true)
    expect(writes.join("")).toContain("HTTP/1.1 401")
  })

  it("passes auth with a valid session token, then 404s the unknown device (never 401)", () => {
    const token = createSessionToken("192.168.1.50")
    const { req, socket, writes } = fakeUpgrade(`/hub/dev_missing_upgrade/__pty?token=${token}`)
    expect(handleHubUpgrade(req, socket, Buffer.alloc(0))).toBe(true)
    const written = writes.join("")
    expect(written).toContain("HTTP/1.1 404")
    expect(written).not.toContain("401")
  })

  it("blocks a blank networkPassword even with a token present", () => {
    mockedGetConfig.mockReturnValue({ claudeDir: "/tmp/claude", networkAccess: true } as never)
    const token = createSessionToken("192.168.1.50")
    const { req, socket, writes } = fakeUpgrade(`/hub/dev_x/__pty?token=${token}`)
    expect(handleHubUpgrade(req, socket, Buffer.alloc(0))).toBe(true)
    expect(writes.join("")).toContain("HTTP/1.1 401")
  })
})

// ── TLS devices route through node:https ─────────────────────────────

describe("tls devices", () => {
  /** Capture https.request options and fail the connect after listeners wire up. */
  function captureHttpsRequests(): Array<Record<string, unknown>> {
    const options: Array<Record<string, unknown>> = []
    mockedHttpsRequest.mockImplementation(((opts: Record<string, unknown>) => {
      options.push(opts)
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: (ms: number) => void
        destroy: () => void
        end: (body?: unknown) => void
      }
      req.setTimeout = vi.fn()
      req.destroy = vi.fn()
      req.end = vi.fn(() => {
        queueMicrotask(() => req.emit("error", new Error("connect failed")))
      })
      return req
    }) as never)
    return options
  }

  function fakeLocalUpgrade(url: string) {
    const socket = {
      write: () => true,
      destroy: () => {},
      get destroyed() { return false },
    } as never
    const req = {
      url,
      headers: { host: "127.0.0.1:19384", origin: "http://127.0.0.1:19384" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage
    return { req, socket }
  }

  beforeEach(() => {
    mockedHttpsRequest.mockReset()
  })

  it("dispatches over node:https and maps a connect failure to a typed 502", async () => {
    const options = captureHttpsRequests()
    const device = await addDevice({ name: "Edge", host: "device.example.com", port: 443, tls: true, auth: "none" })
    const hub = track(await makeHub())

    const res = await fetch(base(hub.port, device.id, "/api/hello"))

    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ code: "DEVICE_UNREACHABLE" })
    expect(options[0]).toMatchObject({ hostname: "device.example.com", port: 443 })
  })

  it("upgrades over node:https and omits :443 from the Host header", async () => {
    const options = captureHttpsRequests()
    const device = await addDevice({ name: "Edge", host: "device.example.com", port: 443, tls: true, auth: "none" })
    const { req, socket } = fakeLocalUpgrade(`/hub/${device.id}/__pty`)

    expect(handleHubUpgrade(req, socket, Buffer.alloc(0))).toBe(true)
    await new Promise((resolve) => setImmediate(resolve))

    expect(options).toHaveLength(1)
    expect((options[0].headers as Record<string, unknown>).host).toBe("device.example.com")
  })

  it("keeps an explicit non-443 port in the upgrade Host header", async () => {
    const options = captureHttpsRequests()
    const device = await addDevice({ name: "Edge8443", host: "device.example.com", port: 8443, tls: true, auth: "none" })
    const { req, socket } = fakeLocalUpgrade(`/hub/${device.id}/__pty`)

    expect(handleHubUpgrade(req, socket, Buffer.alloc(0))).toBe(true)
    await new Promise((resolve) => setImmediate(resolve))

    expect((options[0].headers as Record<string, unknown>).host).toBe("device.example.com:8443")
  })
})

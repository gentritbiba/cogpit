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
import { initDeviceRegistry, addDevice, updateDevice, type HubDevice } from "../../hub/registry"
import { invalidateDeviceToken } from "../../hub/device-client"
import { invalidateDeviceConnections } from "../../hub/connection-invalidation"
import { getConfig } from "../../config"
import { createSessionToken, revokeAllSessions } from "../../security"
import { initEdition, __resetEditionForTest } from "../../team/edition"
import { setRequestPrincipal } from "../../team/requestPrincipal"
import type { SessionPrincipal } from "../../team/constants"

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
  mintCredentials: string[]
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
  const mintCredentials: string[] = []

  const target = {
    requests,
    mintTokens,
    mintCredentials,
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
        mintCredentials.push(String(req.headers.authorization || ""))
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

async function makeHub(principal?: SessionPrincipal): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer((req, res) => {
    // Emulate the mount strip that `use("/hub", handler)` performs in both shells.
    if (req.url?.startsWith("/hub")) req.url = req.url.slice("/hub".length) || "/"
    if (principal) setRequestPrincipal(req, principal)
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
  __resetEditionForTest()
  await Promise.all(openServers.splice(0).map(closeServer))
})

// ── Convenience ──────────────────────────────────────────────────────

async function passwordDevice(port: number, name = "Studio"): Promise<HubDevice> {
  return addDevice({ name, host: "127.0.0.1", port, auth: "password", password: "hunter2secret1" })
}

const base = (hubPort: number, deviceId: string, rest: string) => `http://127.0.0.1:${hubPort}/hub/${deviceId}${rest}`

// ── Tests ────────────────────────────────────────────────────────────

describe("createHubProxyHandler — request rewriting", () => {
  it("uses the current host and credentials when the device changes while a request body is still arriving", async () => {
    const oldTarget = track(await makeTarget((_req, res) => res.end("old")))
    const newTarget = track(await makeTarget((_req, res, r) => res.end(r.body)))
    const device = await addDevice({
      name: "Moving Device",
      host: "localhost",
      port: oldTarget.port,
      auth: "password",
      username: "old-user",
      password: "old-password-123",
    })
    const hub = track(await makeHub())

    // The server's first request listener runs the proxy handler before this
    // listener resolves, proving admission happened against the old record.
    const admitted = new Promise<void>((resolve) => hub.server.once("request", () => resolve()))
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const proxyReq = http.request(base(hub.port, device.id, "/api/send"), {
        method: "POST",
        headers: { "x-cogpit-client": "1" },
      }, (proxyRes) => {
        const chunks: Buffer[] = []
        proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk))
        proxyRes.on("end", () => resolve({
          status: proxyRes.statusCode || 0,
          body: Buffer.concat(chunks).toString(),
        }))
      })
      proxyReq.on("error", reject)
      proxyReq.write("first-")

      void admitted.then(async () => {
        await updateDevice(device.id, {
          host: "127.0.0.1",
          port: newTarget.port,
          username: "new-user",
          password: "new-password-456",
        })
        invalidateDeviceToken(device.id)
        proxyReq.end("second")
      }).catch(reject)
    })

    await admitted
    const result = await response
    expect(result).toEqual({ status: 200, body: "first-second" })
    expect(oldTarget.mintCount).toBe(0)
    expect(oldTarget.requests).toHaveLength(0)
    expect(newTarget.mintCredentials).toEqual(["Bearer new-user:new-password-456"])
    expect(newTarget.requests).toHaveLength(1)
  })

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

  it("does not label a device-origin 502 as a hub failure", async () => {
    // The device is reachable; its own API just failed. The client keys the
    // "device unavailable" banner off X-Cogpit-Hub-Error, so this must stay
    // absent or a broken CLI runtime reads as an offline machine.
    const target = track(await makeTarget((_req, res) => {
      res.statusCode = 502
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ available: false, error: "Claude runtime unavailable" }))
    }))
    const device = await passwordDevice(target.port)
    const hub = track(await makeHub())

    const res = await fetch(base(hub.port, device.id, "/api/claude/runtime"))
    expect(res.status).toBe(502)
    expect(res.headers.get("x-cogpit-device")).toBe(device.id)
    expect(res.headers.get("x-cogpit-hub-error")).toBeNull()
  })

  it("strips a device's forged X-Cogpit-Hub-Error", async () => {
    const target = track(await makeTarget((_req, res) => {
      res.statusCode = 502
      res.setHeader("X-Cogpit-Hub-Error", "DEVICE_UNREACHABLE")
      res.end("forged")
    }))
    const device = await passwordDevice(target.port)
    const hub = track(await makeHub())

    const res = await fetch(base(hub.port, device.id, "/api/thing"))
    expect(res.headers.get("x-cogpit-hub-error")).toBeNull()
  })

  it("labels the hub's own unreachable verdict", async () => {
    const target = track(await makeTarget((_req, res) => res.end("ok")))
    const device = await passwordDevice(target.port)
    const hub = track(await makeHub())
    // Take the device away so the hub genuinely cannot reach it.
    await closeServer(target.server)

    const res = await fetch(base(hub.port, device.id, "/api/thing"))
    expect(res.status).toBe(502)
    expect(res.headers.get("x-cogpit-hub-error")).toBe("DEVICE_UNREACHABLE")
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
  it.each([
    ["member", "/api/auth/logout", { userId: "member", username: "bob", role: "member" }],
    ["member", "/api/auth/verify", { userId: "member", username: "bob", role: "member" }],
    ["admin", "/api/auth/logout", { userId: "admin", username: "alice", role: "admin" }],
    ["admin", "/api/auth/verify", { userId: "admin", username: "alice", role: "admin" }],
  ] as const)("rejects a direct %s request to device auth route %s before credential minting", async (_role, path, principal) => {
    initEdition({ shell: "standalone", configEdition: "team" })
    const target = track(await makeTarget((_req, res) => res.end("should not arrive")))
    const device = await passwordDevice(target.port)
    const hub = track(await makeHub(principal))

    const res = await fetch(base(hub.port, device.id, path), {
      method: "POST",
      headers: { "x-cogpit-client": "1" },
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "HUB_AUTH_ROUTE_FORBIDDEN" })
    expect(target.mintCount).toBe(0)
    expect(target.requests).toHaveLength(0)
  })

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

  it("never resolves a device from a non-origin-form target after the mount strip", async () => {
    // Express keeps the `http://host` prefix on req.url when a client sends an
    // absolute-form target and strips the mount from what follows; Vite's
    // connect strips four characters off the same absolute URI. Neither shape
    // may be read as "/:deviceId/rest", so the device id parse must miss.
    const target = track(await makeTarget((_req, res) => res.end("should not arrive")))
    const device = await passwordDevice(target.port)

    for (const url of [
      `http://cogpit.local:19384/${device.id}/api/x`,
      `://cogpit.local:19384/hub/${device.id}/api/x`,
      `//cogpit.local/${device.id}/api/x`,
    ]) {
      let status = 0
      let body = ""
      const req = { url, method: "GET", headers: {}, on: vi.fn() } as unknown as IncomingMessage
      const res = {
        get statusCode() { return status },
        set statusCode(value: number) { status = value },
        headersSent: false,
        setHeader: vi.fn(),
        end: (data?: string) => { body = data || "" },
      } as unknown as ServerResponse

      handler(req, res, () => { throw new Error("hub paths must not fall through") })

      expect(status).toBe(404)
      expect(JSON.parse(body)).toMatchObject({ code: "UNKNOWN_DEVICE" })
    }
    expect(target.requests).toHaveLength(0)
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
  it("single-flights one replacement mint across concurrent 401 responses", async () => {
    const pendingExpiredResponses: ServerResponse[] = []
    const target = track(await makeTarget((_req, res, r) => {
      if (r.headers.authorization === "Bearer tok-1") {
        pendingExpiredResponses.push(res)
        if (pendingExpiredResponses.length === 3) {
          for (const expired of pendingExpiredResponses) {
            expired.writeHead(401)
            expired.end("expired")
          }
        }
        return
      }
      res.end("ok")
    }))
    const device = await passwordDevice(target.port)
    const hub = track(await makeHub())

    const responses = await Promise.all(Array.from({ length: 3 }, () =>
      fetch(base(hub.port, device.id, "/api/x")),
    ))

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
    expect(await Promise.all(responses.map((response) => response.text())))
      .toEqual(["ok", "ok", "ok"])
    expect(target.mintCount).toBe(2)
    expect(target.requests.filter((request) => request.headers.authorization === "Bearer tok-1")).toHaveLength(3)
    expect(target.requests.filter((request) => request.headers.authorization === "Bearer tok-2")).toHaveLength(3)
  })

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

  it("keeps an SSE stream on rename but closes it when device connection settings change", async () => {
    let streamResponse: ServerResponse | undefined
    const target = track(await makeTarget((_req, res) => {
      streamResponse = res
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      res.write("initial")
    }))
    const device = await passwordDevice(target.port)
    const hub = track(await makeHub())
    const response = await fetch(base(hub.port, device.id, "/api/stream"))
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    expect(decoder.decode((await reader.read()).value)).toContain("initial")
    await updateDevice(device.id, { name: "Renamed Stream Device" })
    streamResponse!.write("after-rename")
    expect(decoder.decode((await reader.read()).value)).toContain("after-rename")

    const closed = reader.read().then(({ done }) => done, () => true)
    invalidateDeviceConnections(device.id)
    await expect(closed).resolves.toBe(true)
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
  it("returns false for a non-hub-transport upgrade path", () => {
    const req = { url: "/__pty", headers: {}, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage
    const fakeSocket = { write: () => {}, destroy: () => {}, destroyed: false } as never
    expect(handleHubUpgrade(req, fakeSocket, Buffer.alloc(0))).toBe(false)
  })

  it("returns false for a hub path that is neither transport", () => {
    const req = {
      url: "/hub/dev_x/__debug",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage
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

  it("proxies a /__browser upgrade to the device, keeping the session query (password device)", async () => {
    // The browser transport carries `?session=<name>`; the device token must be
    // merged into those params, never replace them.
    const wss = new WebSocketServer({ noServer: true })
    wss.on("connection", (ws) => {
      ws.on("message", (m) => ws.send(`echo:${m}`))
    })
    let deviceUrl: string | null = null
    const targetServer = http.createServer((req, res) => {
      if (req.url === "/api/auth/verify" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ valid: true, token: "device-token-1" }))
        return
      }
      res.end()
    })
    targetServer.on("upgrade", (req, socket, head) => {
      deviceUrl = req.url || ""
      const u = new URL(req.url || "/", "http://localhost")
      if (u.pathname === "/__browser") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
      else socket.destroy()
    })
    openServers.push(targetServer)
    const targetPort = await listen(targetServer)

    const device = await addDevice({
      name: "Studio", host: "127.0.0.1", port: targetPort, auth: "password", password: "hunter2secret1",
    })
    const hub = track(await makeHub())

    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/hub/${device.id}/__browser?session=work`)
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

      const forwarded = new URL(deviceUrl as unknown as string, "http://localhost")
      expect(forwarded.pathname).toBe("/__browser")
      expect(forwarded.searchParams.get("session")).toBe("work")
      expect(forwarded.searchParams.get("token")).toBe("device-token-1")
    } finally {
      ws.close()
      wss.close()
    }
  })

  it("forwards the hub client token as the device token on a /__pty upgrade", async () => {
    const wss = new WebSocketServer({ noServer: true })
    wss.on("connection", (ws) => ws.on("message", (m) => ws.send(`echo:${m}`)))
    let deviceUrl: string | null = null
    const targetServer = http.createServer((req, res) => {
      if (req.url === "/api/auth/verify" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ valid: true, token: "device-token-1" }))
        return
      }
      res.end()
    })
    targetServer.on("upgrade", (req, socket, head) => {
      deviceUrl = req.url || ""
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
    })
    openServers.push(targetServer)
    const targetPort = await listen(targetServer)

    const device = await addDevice({
      name: "Studio", host: "127.0.0.1", port: targetPort, auth: "password", password: "hunter2secret1",
    })
    const hub = track(await makeHub())
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/hub/${device.id}/__pty?token=hub-client-token`)

    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve())
        ws.once("error", reject)
      })
      // The hub's own client token never travels onward; only the device lease does.
      expect(deviceUrl).toBe("/__pty?token=device-token-1")
    } finally {
      ws.close()
      wss.close()
    }
  })

  it("keeps a tunnel on name-only changes but closes it on device connection invalidation", async () => {
    const wss = new WebSocketServer({ noServer: true })
    wss.on("connection", (peer) => {
      peer.on("message", (message) => peer.send(`echo:${message}`))
    })
    const targetServer = http.createServer((_req, res) => res.end())
    targetServer.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (peer) => wss.emit("connection", peer, req))
    })
    openServers.push(targetServer)
    const targetPort = await listen(targetServer)
    const device = await addDevice({
      name: "Tunnel",
      host: "127.0.0.1",
      port: targetPort,
      auth: "none",
    })
    const hub = track(await makeHub())
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/hub/${device.id}/__pty`)

    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve)
        ws.once("error", reject)
      })

      // Neither another device's invalidation nor a cosmetic update may tear
      // down this established terminal.
      invalidateDeviceConnections("dev_other")
      await updateDevice(device.id, { name: "Renamed Tunnel" })
      const reply = new Promise<string>((resolve) => {
        ws.once("message", (message) => resolve(message.toString()))
      })
      ws.send("still-open")
      await expect(reply).resolves.toBe("echo:still-open")

      const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()))
      invalidateDeviceConnections(device.id)
      await closed
      expect(ws.readyState).toBe(WebSocket.CLOSED)
    } finally {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
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
    let destroyed = false
    const socket = new EventEmitter() as EventEmitter & {
      write: () => boolean
      destroy: () => void
      readonly destroyed: boolean
    }
    socket.write = () => true
    socket.destroy = () => {
      if (destroyed) return
      destroyed = true
      socket.emit("close")
    }
    Object.defineProperty(socket, "destroyed", { get: () => destroyed })
    const req = {
      url,
      headers: { host: "127.0.0.1:19384", origin: "http://127.0.0.1:19384" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage
    return { req, socket: socket as never }
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

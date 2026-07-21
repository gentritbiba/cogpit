// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createServer, request, type Server } from "node:http"
import { connect } from "node:net"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createAppServer } from "../../electron/server"
import { createStandaloneAppServer } from "../standalone-app-server"
import { WebSocket } from "ws"
import { hashPassword } from "../security"

type AppServerFactory = (
  staticDir: string,
  userDataDir: string,
) => Promise<{ httpServer: Server }>

const adapterCases: ReadonlyArray<readonly [
  name: string,
  mode: "electron" | "standalone",
  factory: AppServerFactory,
]> = [
  ["Electron", "electron", createAppServer],
  ["standalone", "standalone", createStandaloneAppServer],
]

const openServers = new Set<Server>()
let fixtureRoot: string
let staticDir: string
let userDataDir: string

async function listen(server: Server): Promise<string> {
  openServers.add(server)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address")
  }
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server): Promise<void> {
  if (!server.listening) {
    openServers.delete(server)
    return
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  openServers.delete(server)
}

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "cogpit-app-server-"))
  staticDir = join(fixtureRoot, "static")
  userDataDir = join(fixtureRoot, "user-data")
  await Promise.all([
    mkdir(staticDir, { recursive: true }),
    mkdir(userDataDir, { recursive: true }),
  ])
  await writeFile(join(staticDir, "index.html"), "<main>composition-fixture</main>")
  delete process.env.ELECTRON_RENDERER_URL
})

afterEach(async () => {
  delete process.env.ELECTRON_RENDERER_URL
  await Promise.all([...openServers].map(close))
  await rm(fixtureRoot, { recursive: true, force: true })
})

describe.each(adapterCases)("%s app-server adapter", (_name, expectedMode, factory) => {
  it("preserves platform mode, public route ordering, and SPA fallback", async () => {
    const { httpServer } = await factory(staticDir, userDataDir)
    const baseUrl = await listen(httpServer)

    const helloResponse = await fetch(`${baseUrl}/api/hello`)
    expect(helloResponse.status).toBe(200)
    await expect(helloResponse.json()).resolves.toMatchObject({
      app: "cogpit",
      mode: expectedMode,
    })

    const fallbackResponse = await fetch(`${baseUrl}/deep/client/route`)
    expect(fallbackResponse.status).toBe(200)
    await expect(fallbackResponse.text()).resolves.toBe("<main>composition-fixture</main>")

    await close(httpServer)
  })

  it("preserves the environment-selected Vite development proxy", async () => {
    const upstream = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ method: req.method, url: req.url }))
    })
    const upstreamUrl = await listen(upstream)
    process.env.ELECTRON_RENDERER_URL = upstreamUrl

    const { httpServer } = await factory(staticDir, userDataDir)
    const baseUrl = await listen(httpServer)
    const response = await fetch(`${baseUrl}/vite-probe?source=adapter`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      method: "GET",
      url: "/vite-probe?source=adapter",
    })

    await Promise.all([close(httpServer), close(upstream)])
  })
})

describe("app-server upgrade lifecycle", () => {
  it("rejects and closes an unmatched production WebSocket upgrade", async () => {
    const { httpServer, dispose } = await createStandaloneAppServer(staticDir, userDataDir)
    const baseUrl = new URL(await listen(httpServer))

    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(baseUrl.port), baseUrl.hostname)
      let received = ""
      const timeout = setTimeout(() => {
        socket.destroy()
        reject(new Error("Unmatched upgrade socket remained open"))
      }, 1_000)

      socket.setEncoding("utf8")
      socket.on("connect", () => {
        socket.write(
          "GET /not-a-websocket-route HTTP/1.1\r\n"
          + `Host: ${baseUrl.host}\r\n`
          + "Connection: Upgrade\r\n"
          + "Upgrade: websocket\r\n\r\n",
        )
      })
      socket.on("data", (chunk) => { received += chunk })
      socket.on("error", reject)
      socket.on("close", () => {
        clearTimeout(timeout)
        resolve(received)
      })
    })

    expect(response).toContain("404 Not Found")
    await dispose()
    openServers.delete(httpServer)
  })

  it("disposes accepted WebSocket clients before awaiting HTTP shutdown", async () => {
    const { httpServer, dispose } = await createStandaloneAppServer(staticDir, userDataDir)
    const baseUrl = await listen(httpServer)
    const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/__pty`)

    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve)
      ws.once("error", reject)
    })
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()))

    await dispose()
    await closed
    expect(httpServer.listening).toBe(false)
    openServers.delete(httpServer)
  })

  it("rejects a forwarded PTY upgrade without a session token", async () => {
    const { httpServer, dispose } = await createStandaloneAppServer(staticDir, userDataDir)
    const baseUrl = new URL(await listen(httpServer))

    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(baseUrl.port), baseUrl.hostname)
      let received = ""
      const timeout = setTimeout(() => {
        socket.destroy()
        reject(new Error("Rejected PTY upgrade socket remained open"))
      }, 1_000)
      socket.setEncoding("utf8")
      socket.on("connect", () => socket.write(
        "GET /__pty HTTP/1.1\r\n"
        + `Host: localhost:${baseUrl.port}\r\n`
        + "X-Forwarded-For: 203.0.113.8\r\n"
        + "Connection: Upgrade\r\n"
        + "Upgrade: websocket\r\n\r\n",
      ))
      socket.on("data", (chunk) => { received += chunk })
      socket.on("error", reject)
      socket.on("close", () => {
        clearTimeout(timeout)
        resolve(received)
      })
    })

    expect(response).toContain("401 Unauthorized")
    await dispose()
    openServers.delete(httpServer)
  })
})

describe("app-server initialization and proxy failures", () => {
  it("blocks data APIs until configuration exists", async () => {
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = join(fixtureRoot, "missing-codex-home")
    try {
      const appServer = await createStandaloneAppServer(staticDir, userDataDir)
      const baseUrl = await listen(appServer.httpServer)

      const response = await fetch(`${baseUrl}/api/projects`)

      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toMatchObject({ code: "NOT_CONFIGURED" })
      await appServer.dispose()
      openServers.delete(appServer.httpServer)
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  })

  it("returns 502 when the configured Vite development server is unavailable", async () => {
    const unavailable = createServer()
    const unavailableUrl = await listen(unavailable)
    await close(unavailable)
    process.env.ELECTRON_RENDERER_URL = unavailableUrl

    const appServer = await createStandaloneAppServer(staticDir, userDataDir)
    const baseUrl = await listen(appServer.httpServer)
    const response = await fetch(`${baseUrl}/vite-unavailable`)

    expect(response.status).toBe(502)
    await expect(response.text()).resolves.toBe("Vite dev server not ready")
    await appServer.dispose()
    openServers.delete(appServer.httpServer)
  })
})

describe("app-server reverse-proxy trust", () => {
  it("requires password and token auth through a real loopback proxy", async () => {
    const password = "reverse-proxy-password"
    await writeFile(join(userDataDir, "config.local.json"), JSON.stringify({
      claudeDir: fixtureRoot,
      networkAccess: true,
      networkPassword: hashPassword(password),
    }))

    const appServer = await createStandaloneAppServer(staticDir, userDataDir)
    const appUrl = new URL(await listen(appServer.httpServer))
    const proxy = createServer((incoming, outgoing) => {
      const proxyRequest = request({
        hostname: appUrl.hostname,
        port: appUrl.port,
        path: incoming.url,
        method: incoming.method,
        headers: {
          ...incoming.headers,
          host: `localhost:${appUrl.port}`,
          "x-forwarded-for": incoming.socket.remoteAddress || "unknown",
        },
      }, (proxyResponse) => {
        outgoing.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers)
        proxyResponse.pipe(outgoing)
      })
      proxyRequest.on("error", () => outgoing.writeHead(502).end())
      incoming.pipe(proxyRequest)
    })
    const proxyUrl = await listen(proxy)

    const missingPassword = await fetch(`${proxyUrl}/api/auth/verify`, { method: "POST" })
    expect(missingPassword.status).toBe(401)

    const verified = await fetch(`${proxyUrl}/api/auth/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${password}` },
    })
    expect(verified.status).toBe(200)
    const { token } = await verified.json() as { token: string }
    expect(token).toMatch(/^[0-9a-f]{64}$/)

    expect((await fetch(`${proxyUrl}/api/network-info`)).status).toBe(401)
    expect((await fetch(`${proxyUrl}/api/network-info`, {
      headers: { Authorization: `Bearer ${token}` },
    })).status).toBe(200)

    await Promise.all([close(proxy), appServer.dispose()])
    openServers.delete(appServer.httpServer)
  })
})

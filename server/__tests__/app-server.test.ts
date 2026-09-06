// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer, request, type Server } from "node:http"
import { connect } from "node:net"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createAppServer } from "../../electron/server"
import { createStandaloneAppServer } from "../standalone-app-server"
import { WebSocket, WebSocketServer } from "ws"
import { hashPassword, __resetSessionsForTest } from "../security"
import { __resetEditionForTest } from "../team/edition"
import { __resetUsersForTest } from "../team/users"
import { __resetBootstrapTokenForTest } from "../team/bootstrapToken"
import {
  __flushForTest as flushSessionPersistence,
  __resetForTest as __resetSessionPersistenceForTest,
} from "../team/sessionPersistence"

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
let previousBrowserHome: string | undefined
let previousSkillHome: string | undefined

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
  // Composition installs the browser shim, the plugin and the per-CLI skill;
  // keep all of that inside the fixture rather than the developer's home.
  previousBrowserHome = process.env.COGPIT_BROWSER_HOME
  previousSkillHome = process.env.COGPIT_SKILL_HOME
  process.env.COGPIT_BROWSER_HOME = join(fixtureRoot, "browser")
  process.env.COGPIT_SKILL_HOME = join(fixtureRoot, "home")
})

afterEach(async () => {
  delete process.env.ELECTRON_RENDERER_URL
  if (previousBrowserHome === undefined) delete process.env.COGPIT_BROWSER_HOME
  else process.env.COGPIT_BROWSER_HOME = previousBrowserHome
  if (previousSkillHome === undefined) delete process.env.COGPIT_SKILL_HOME
  else process.env.COGPIT_SKILL_HOME = previousSkillHome
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

  it("serves SPA deep links when the build lives under a hidden worktree directory", async () => {
    const hiddenStaticDir = join(fixtureRoot, ".worktrees", "preview", "dist")
    await mkdir(hiddenStaticDir, { recursive: true })
    await writeFile(join(hiddenStaticDir, "index.html"), "<main>hidden-worktree-fixture</main>")

    const { httpServer } = await factory(hiddenStaticDir, userDataDir)
    const baseUrl = await listen(httpServer)
    const response = await fetch(`${baseUrl}/preview/session-123`)

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe("<main>hidden-worktree-fixture</main>")
    await close(httpServer)
  })

  // A packaged app runs from a read-only bundle, so anything Cogpit writes for
  // itself has to land in the user-data directory it was handed. Reading the
  // value back proves the composition pointed the store somewhere writable.
  it("stores per-session config under the user-data directory", async () => {
    await writeFile(
      join(userDataDir, "config.local.json"),
      JSON.stringify({ claudeDir: fixtureRoot }),
    )
    const { httpServer } = await factory(staticDir, userDataDir)
    const baseUrl = await listen(httpServer)

    const saved = await fetch(`${baseUrl}/api/session-config/probe.jsonl`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ultracode: false }),
    })
    expect(saved.status).toBe(200)

    await expect(
      readFile(join(userDataDir, "session-config", "probe.jsonl.json"), "utf-8"),
    ).resolves.toContain('"ultracode": false')

    const reloaded = await fetch(`${baseUrl}/api/session-config/probe.jsonl`)
    await expect(reloaded.json()).resolves.toEqual({ ultracode: false })

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

  it("disposes accepted browser viewer clients before awaiting HTTP shutdown", async () => {
    const previousBrowserHome = process.env.COGPIT_BROWSER_HOME
    process.env.COGPIT_BROWSER_HOME = join(fixtureRoot, "browser-home")
    try {
      const { httpServer, dispose } = await createStandaloneAppServer(staticDir, userDataDir)
      const baseUrl = await listen(httpServer)
      const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/__browser?session=qa-fixture`)

      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve)
        ws.once("error", reject)
      })
      const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()))

      await dispose()
      await closed
      expect(httpServer.listening).toBe(false)
      openServers.delete(httpServer)
    } finally {
      if (previousBrowserHome === undefined) delete process.env.COGPIT_BROWSER_HOME
      else process.env.COGPIT_BROWSER_HOME = previousBrowserHome
    }
  })

  it("rejects a forwarded browser upgrade without a session token", async () => {
    const { httpServer, dispose } = await createStandaloneAppServer(staticDir, userDataDir)
    const baseUrl = new URL(await listen(httpServer))

    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(baseUrl.port), baseUrl.hostname)
      let received = ""
      const timeout = setTimeout(() => {
        socket.destroy()
        reject(new Error("Rejected browser upgrade socket remained open"))
      }, 1_000)
      socket.setEncoding("utf8")
      socket.on("connect", () => socket.write(
        "GET /__browser?session=qa-fixture HTTP/1.1\r\n"
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
    const previousCopilotHome = process.env.COPILOT_HOME
    const previousPath = process.env.PATH
    process.env.CODEX_HOME = join(fixtureRoot, "missing-codex-home")
    process.env.COPILOT_HOME = join(fixtureRoot, "missing-copilot-home")
    process.env.PATH = join(fixtureRoot, "missing-bin-dir")
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
      if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME
      else process.env.COPILOT_HOME = previousCopilotHome
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  it("leaves /api/me and the team bootstrap reachable before configuration", async () => {
    const previousCodexHome = process.env.CODEX_HOME
    const previousCopilotHome = process.env.COPILOT_HOME
    const previousPath = process.env.PATH
    process.env.CODEX_HOME = join(fixtureRoot, "missing-codex-home")
    process.env.COPILOT_HOME = join(fixtureRoot, "missing-copilot-home")
    process.env.PATH = join(fixtureRoot, "missing-bin-dir")
    try {
      const appServer = await createStandaloneAppServer(staticDir, userDataDir)
      const baseUrl = await listen(appServer.httpServer)

      // Same unconfigured server: data APIs stay 503-gated…
      const blocked = await fetch(`${baseUrl}/api/projects`)
      expect(blocked.status).toBe(503)

      // …while identity discovery answers.
      const me = await fetch(`${baseUrl}/api/me`)
      expect(me.status).toBe(200)
      await expect(me.json()).resolves.toMatchObject({
        authenticated: true,
        edition: "personal",
      })

      // Personal edition has no bootstrap (404 from the route itself); the
      // point is that the NOT_CONFIGURED guard did not answer 503.
      const bootstrap = await fetch(`${baseUrl}/api/team/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice", password: "irrelevant" }),
      })
      expect(bootstrap.status).toBe(404)

      await appServer.dispose()
      openServers.delete(appServer.httpServer)
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME
      else process.env.COPILOT_HOME = previousCopilotHome
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  it("matches 503-gate exemptions on segment boundaries only", async () => {
    const previousCodexHome = process.env.CODEX_HOME
    const previousCopilotHome = process.env.COPILOT_HOME
    const previousPath = process.env.PATH
    process.env.CODEX_HOME = join(fixtureRoot, "missing-codex-home")
    process.env.COPILOT_HOME = join(fixtureRoot, "missing-copilot-home")
    process.env.PATH = join(fixtureRoot, "missing-bin-dir")
    try {
      const appServer = await createStandaloneAppServer(staticDir, userDataDir)
      const baseUrl = await listen(appServer.httpServer)

      // /api/messages must not inherit the /api/me exemption.
      const messages = await fetch(`${baseUrl}/api/messages`)
      expect(messages.status).toBe(503)
      await expect(messages.json()).resolves.toMatchObject({ code: "NOT_CONFIGURED" })

      // The exempt path itself stays reachable, query string included.
      const me = await fetch(`${baseUrl}/api/me?probe=1`)
      expect(me.status).toBe(200)

      await appServer.dispose()
      openServers.delete(appServer.httpServer)
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME
      else process.env.COPILOT_HOME = previousCopilotHome
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
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

describe("app-server team edition composition", () => {
  const originalEdition = process.env.COGPIT_EDITION
  const originalBootstrapToken = process.env.COGPIT_BOOTSTRAP_TOKEN

  afterEach(async () => {
    if (originalEdition === undefined) delete process.env.COGPIT_EDITION
    else process.env.COGPIT_EDITION = originalEdition
    if (originalBootstrapToken === undefined) delete process.env.COGPIT_BOOTSTRAP_TOKEN
    else process.env.COGPIT_BOOTSTRAP_TOKEN = originalBootstrapToken
    await flushSessionPersistence()
    __resetEditionForTest()
    __resetUsersForTest()
    __resetSessionsForTest()
    __resetSessionPersistenceForTest()
    __resetBootstrapTokenForTest()
  })

  it("boots the standalone shell in team edition with the first-admin bootstrap open", async () => {
    process.env.COGPIT_EDITION = "team"
    process.env.COGPIT_BOOTSTRAP_TOKEN = "app-server-bootstrap-token-at-least-32-chars"
    const { httpServer, dispose } = await createStandaloneAppServer(staticDir, userDataDir)
    const baseUrl = await listen(httpServer)

    // The trust model flipped: a local unauthenticated data request is refused…
    const projects = await fetch(`${baseUrl}/api/projects`)
    expect(projects.status).toBe(401)

    // …the public handshake advertises the edition…
    const hello = await fetch(`${baseUrl}/api/hello`)
    const helloBody = await hello.text()
    expect(JSON.parse(helloBody)).toMatchObject({ app: "cogpit", edition: "team" })
    expect(helloBody).not.toContain(process.env.COGPIT_BOOTSTRAP_TOKEN!)

    const uncredentialedBootstrap = await fetch(`${baseUrl}/api/team/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attacker", password: "attacker-passphrase-1" }),
    })
    expect(uncredentialedBootstrap.status).toBe(403)

    // …and the zero-user bootstrap works, proving the users store initialized
    // before requests were served.
    const bootstrap = await fetch(`${baseUrl}/api/team/bootstrap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cogpit-Bootstrap-Token": process.env.COGPIT_BOOTSTRAP_TOKEN,
      },
      body: JSON.stringify({ username: "founder", password: "founder-passphrase-1" }),
    })
    expect(bootstrap.status).toBe(200)
    const issued = await bootstrap.json() as { valid: boolean; token?: string }
    expect(issued.valid).toBe(true)
    expect(issued.token).toMatch(/^[0-9a-f]{64}$/)

    const pty = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/__pty?token=${issued.token}`)
    await new Promise<void>((resolve, reject) => {
      pty.once("open", resolve)
      pty.once("error", reject)
    })

    // A configless team server must still allow reload/login after the one-time
    // bootstrap; the NOT_CONFIGURED data gate begins after auth endpoints.
    const login = await fetch(`${baseUrl}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "founder", password: "founder-passphrase-1" }),
    })
    expect(login.status).toBe(200)
    await expect(login.json()).resolves.toMatchObject({ valid: true })

    const socketClosed = new Promise<number>((resolve) => pty.once("close", resolve))
    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${issued.token}` },
    })
    expect(logout.status).toBe(200)
    await expect(socketClosed).resolves.toBe(1008)

    await dispose()
    openServers.delete(httpServer)
  })

  it("preserves edition-only team mode through first configuration and restart", async () => {
    delete process.env.COGPIT_EDITION
    process.env.COGPIT_BOOTSTRAP_TOKEN = "edition-only-bootstrap-token-at-least-32-chars"
    const claudeDir = join(fixtureRoot, "configured-claude")
    await Promise.all([
      mkdir(join(claudeDir, "projects"), { recursive: true }),
      writeFile(join(userDataDir, "config.local.json"), JSON.stringify({ edition: "team" })),
    ])

    const first = await createStandaloneAppServer(staticDir, userDataDir)
    const firstUrl = await listen(first.httpServer)
    const bootstrap = await fetch(`${firstUrl}/api/team/bootstrap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cogpit-Bootstrap-Token": process.env.COGPIT_BOOTSTRAP_TOKEN,
      },
      body: JSON.stringify({ username: "founder", password: "founder-passphrase-1" }),
    })
    expect(bootstrap.status).toBe(200)
    const { token } = await bootstrap.json() as { token: string }

    const configured = await fetch(`${firstUrl}/api/config`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ claudeDir }),
    })
    expect(configured.status).toBe(200)
    await first.dispose()
    openServers.delete(first.httpServer)

    await expect(readFile(join(userDataDir, "config.local.json"), "utf-8"))
      .resolves.toContain('"edition": "team"')

    // Simulate a fresh process: only disk state may select the edition or
    // restore the account/session stores now.
    __resetEditionForTest()
    __resetUsersForTest()
    __resetSessionsForTest()
    __resetSessionPersistenceForTest()
    __resetBootstrapTokenForTest()
    delete process.env.COGPIT_BOOTSTRAP_TOKEN

    const restarted = await createStandaloneAppServer(staticDir, userDataDir)
    const restartedUrl = await listen(restarted.httpServer)
    const hello = await fetch(`${restartedUrl}/api/hello`)
    await expect(hello.json()).resolves.toMatchObject({
      edition: "team",
      needsBootstrap: false,
      configured: true,
    })
    const login = await fetch(`${restartedUrl}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "founder", password: "founder-passphrase-1" }),
    })
    expect(login.status).toBe(200)

    await restarted.dispose()
    openServers.delete(restarted.httpServer)
  })

  it("closes an established hub PTY tunnel when its outer session is revoked", async () => {
    process.env.COGPIT_EDITION = "team"
    process.env.COGPIT_BOOTSTRAP_TOKEN = "hub-pty-bootstrap-token-at-least-32-chars"

    const targetWss = new WebSocketServer({ noServer: true })
    targetWss.on("connection", (ws) => ws.on("message", (data) => ws.send(data)))
    const targetServer = createServer()
    targetServer.on("upgrade", (req, socket, head) => {
      if (new URL(req.url || "/", "http://localhost").pathname !== "/__pty") {
        socket.destroy()
        return
      }
      targetWss.handleUpgrade(req, socket, head, (ws) => targetWss.emit("connection", ws, req))
    })
    const targetUrl = new URL(await listen(targetServer))
    await writeFile(join(userDataDir, "devices.local.json"), JSON.stringify([{
      id: "dev_echo",
      name: "Echo",
      host: targetUrl.hostname,
      port: Number(targetUrl.port),
      auth: "none",
      addedAt: Date.now(),
    }]))

    const { httpServer, dispose } = await createStandaloneAppServer(staticDir, userDataDir)
    const baseUrl = await listen(httpServer)
    const bootstrap = await fetch(`${baseUrl}/api/team/bootstrap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cogpit-Bootstrap-Token": process.env.COGPIT_BOOTSTRAP_TOKEN,
      },
      body: JSON.stringify({ username: "founder", password: "founder-passphrase-1" }),
    })
    const { token } = await bootstrap.json() as { token: string }

    const tunnel = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/hub/dev_echo/__pty?token=${token}`)
    await new Promise<void>((resolve, reject) => {
      tunnel.once("open", resolve)
      tunnel.once("error", reject)
    })
    const echo = new Promise<string>((resolve) => tunnel.once("message", (data) => resolve(data.toString())))
    tunnel.send("ping")
    await expect(echo).resolves.toBe("ping")

    const tunnelClosed = new Promise<void>((resolve) => tunnel.once("close", () => resolve()))
    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(logout.status).toBe(200)
    await tunnelClosed

    await dispose()
    openServers.delete(httpServer)
    targetWss.close()
    await close(targetServer)
  })

  it("closes an established hub browser tunnel when its outer session is revoked", async () => {
    process.env.COGPIT_EDITION = "team"
    process.env.COGPIT_BOOTSTRAP_TOKEN = "hub-browser-bootstrap-token-at-least-32-chars"

    const targetWss = new WebSocketServer({ noServer: true })
    targetWss.on("connection", (ws) => ws.on("message", (data) => ws.send(data)))
    const targetServer = createServer()
    let deviceUrl: string | null = null
    targetServer.on("upgrade", (req, socket, head) => {
      deviceUrl = req.url || ""
      if (new URL(req.url || "/", "http://localhost").pathname !== "/__browser") {
        socket.destroy()
        return
      }
      targetWss.handleUpgrade(req, socket, head, (ws) => targetWss.emit("connection", ws, req))
    })
    const targetUrl = new URL(await listen(targetServer))
    await writeFile(join(userDataDir, "devices.local.json"), JSON.stringify([{
      id: "dev_view",
      name: "Viewer",
      host: targetUrl.hostname,
      port: Number(targetUrl.port),
      auth: "none",
      addedAt: Date.now(),
    }]))

    const { httpServer, dispose } = await createStandaloneAppServer(staticDir, userDataDir)
    const baseUrl = await listen(httpServer)
    const bootstrap = await fetch(`${baseUrl}/api/team/bootstrap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cogpit-Bootstrap-Token": process.env.COGPIT_BOOTSTRAP_TOKEN,
      },
      body: JSON.stringify({ username: "founder", password: "founder-passphrase-1" }),
    })
    const { token } = await bootstrap.json() as { token: string }

    const tunnel = new WebSocket(
      `${baseUrl.replace(/^http/, "ws")}/hub/dev_view/__browser?session=work&token=${token}`,
    )
    await new Promise<void>((resolve, reject) => {
      tunnel.once("open", resolve)
      tunnel.once("error", reject)
    })
    // The device sees the browser it was asked for, never the hub's own token.
    expect(deviceUrl).toBe("/__browser?session=work")
    const echo = new Promise<string>((resolve) => tunnel.once("message", (data) => resolve(data.toString())))
    tunnel.send("ping")
    await expect(echo).resolves.toBe("ping")

    const tunnelClosed = new Promise<void>((resolve) => tunnel.once("close", () => resolve()))
    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(logout.status).toBe(200)
    await tunnelClosed

    await dispose()
    openServers.delete(httpServer)
    targetWss.close()
    await close(targetServer)
  })

  it("closes an established direct task-output SSE stream on logout", async () => {
    process.env.COGPIT_EDITION = "team"
    process.env.COGPIT_BOOTSTRAP_TOKEN = "direct-sse-bootstrap-token-at-least-32-chars"
    await writeFile(join(userDataDir, "config.local.json"), JSON.stringify({
      edition: "team",
      claudeDir: fixtureRoot,
    }))
    const outputBase = process.platform === "win32" ? tmpdir() : "/tmp"
    const outputDir = await mkdtemp(join(outputBase, "claude-cogpit-sse-"))
    const outputPath = join(outputDir, "output.txt")
    await writeFile(outputPath, "initial output")

    const { httpServer, dispose } = await createStandaloneAppServer(staticDir, userDataDir)
    const baseUrl = await listen(httpServer)
    const bootstrap = await fetch(`${baseUrl}/api/team/bootstrap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cogpit-Bootstrap-Token": process.env.COGPIT_BOOTSTRAP_TOKEN,
      },
      body: JSON.stringify({ username: "founder", password: "founder-passphrase-1" }),
    })
    const { token } = await bootstrap.json() as { token: string }

    const stream = await fetch(`${baseUrl}/api/task-output?path=${encodeURIComponent(outputPath)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const reader = stream.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("initial output")

    const closed = reader.read().then(({ done }) => done, () => true)
    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(logout.status).toBe(200)
    await expect(closed).resolves.toBe(true)

    await dispose()
    openServers.delete(httpServer)
    await rm(outputDir, { recursive: true, force: true })
  })

  it("closes an established hub SSE stream when its outer session is revoked", async () => {
    process.env.COGPIT_EDITION = "team"
    process.env.COGPIT_BOOTSTRAP_TOKEN = "hub-sse-bootstrap-token-at-least-32-chars"
    await writeFile(join(userDataDir, "config.local.json"), JSON.stringify({
      edition: "team",
      claudeDir: fixtureRoot,
    }))

    const targetServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      res.write("data: initial\n\n")
    })
    const targetUrl = new URL(await listen(targetServer))
    await writeFile(join(userDataDir, "devices.local.json"), JSON.stringify([{
      id: "dev_stream",
      name: "Stream",
      host: targetUrl.hostname,
      port: Number(targetUrl.port),
      auth: "none",
      connectionRevision: 0,
      addedAt: Date.now(),
    }]))

    const { httpServer, dispose } = await createStandaloneAppServer(staticDir, userDataDir)
    const baseUrl = await listen(httpServer)
    const bootstrap = await fetch(`${baseUrl}/api/team/bootstrap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cogpit-Bootstrap-Token": process.env.COGPIT_BOOTSTRAP_TOKEN,
      },
      body: JSON.stringify({ username: "founder", password: "founder-passphrase-1" }),
    })
    const { token } = await bootstrap.json() as { token: string }

    const stream = await fetch(`${baseUrl}/hub/dev_stream/api/task-output?path=ignored`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const reader = stream.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("initial")

    const closed = reader.read().then(({ done }) => done, () => true)
    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(logout.status).toBe(200)
    await expect(closed).resolves.toBe(true)

    await dispose()
    openServers.delete(httpServer)
    await close(targetServer)
  })

  it("fails the team boot loudly when the users store is corrupt", async () => {
    process.env.COGPIT_EDITION = "team"
    await mkdir(join(userDataDir, "team"), { recursive: true })

    // A corrupt store must abort composition (fail closed), never boot with an
    // empty user list that would reopen the unauthenticated bootstrap.
    await writeFile(join(userDataDir, "team", "users.json"), '{"users":42}')
    await expect(createStandaloneAppServer(staticDir, userDataDir))
      .rejects.toThrow("Malformed team users store")

    await writeFile(join(userDataDir, "team", "users.json"), "not-json{{{")
    await expect(createStandaloneAppServer(staticDir, userDataDir)).rejects.toThrow()
  })

  it("warns when composition loads an unrecognized persisted edition", async () => {
    await writeFile(join(userDataDir, "config.local.json"), JSON.stringify({
      claudeDir: fixtureRoot,
      edition: "enterprise",
    }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    try {
      const appServer = await createStandaloneAppServer(staticDir, userDataDir)
      await listen(appServer.httpServer)

      try {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(
          'config.local.json edition "enterprise" is not recognized',
        ))
      } finally {
        await appServer.dispose()
        openServers.delete(appServer.httpServer)
      }
    } finally {
      warn.mockRestore()
    }
  })

  it("forces personal composition for the electron shell even when env says team", async () => {
    process.env.COGPIT_EDITION = "team"
    const { httpServer, dispose } = await createAppServer(staticDir, userDataDir)
    const baseUrl = await listen(httpServer)

    const hello = await fetch(`${baseUrl}/api/hello`)
    await expect(hello.json()).resolves.toMatchObject({ edition: "personal" })

    await dispose()
    openServers.delete(httpServer)
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

    const remotePty = new WebSocket(
      `${appUrl.toString().replace(/^http/, "ws").replace(/\/$/, "")}/__pty?token=${token}`,
      { headers: { "x-forwarded-for": "203.0.113.8" } },
    )
    await new Promise<void>((resolve, reject) => {
      remotePty.once("open", resolve)
      remotePty.once("error", reject)
    })
    const remotePtyClosed = new Promise<number>((resolve) => remotePty.once("close", resolve))
    const logout = await fetch(`${proxyUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(logout.status).toBe(200)
    await expect(remotePtyClosed).resolves.toBe(1008)

    await Promise.all([close(proxy), appServer.dispose()])
    openServers.delete(appServer.httpServer)
  })
})

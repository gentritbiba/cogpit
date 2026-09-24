// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer, request } from "node:http"
import { connect } from "node:net"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { WebSocket } from "ws"
import { hashPassword } from "../security"
import { __resetEditionForTest } from "../edition"
import {
  close,
  createAppServer,
  createDevAppServer,
  createStandaloneAppServer,
  fixtureRoot,
  listen,
  openServers,
  staticDir,
  useAppServerFixture,
  userDataDir,
} from "./appServerFixture"

type AppServerFactory = typeof createAppServer

const adapterCases: ReadonlyArray<readonly [
  name: string,
  mode: "electron" | "standalone",
  factory: AppServerFactory,
]> = [
  ["Electron", "electron", createAppServer],
  ["standalone", "standalone", createStandaloneAppServer],
]

const shellCases: ReadonlyArray<readonly [name: string, factory: AppServerFactory]> = [
  ...adapterCases.map(([name, , factory]) => [name, factory] as const),
  ["Vite dev", createDevAppServer],
]

useAppServerFixture()

describe.each(shellCases)("%s shell", (_name, factory) => {
  it("answers an API path no handler serves with a JSON 404, never the app shell", async () => {
    await writeFile(join(userDataDir, "config.local.json"), JSON.stringify({ claudeDir: fixtureRoot }))
    const { httpServer } = await factory(staticDir, userDataDir)
    const baseUrl = await listen(httpServer)

    for (const [method, path] of [["GET", "/api/active-sessions/unserved"], ["HEAD", "/api/find-session/a/b"], ["POST", "/api/unserved"]]) {
      const response = await fetch(`${baseUrl}${path}`, { method })
      expect({ status: response.status, type: response.headers.get("content-type") }, `${method} ${path}`)
        .toEqual({ status: 404, type: expect.stringMatching(/^application\/json/) })
      if (method !== "HEAD") await expect(response.json()).resolves.toEqual({ error: "Not found", code: "NOT_FOUND" })
    }

    await close(httpServer)
  })
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

describe("app-server shutdown", () => {
  const SESSION = "5d000000-0000-4000-8000-00000000d15c"

  it.each(adapterCases)("%s: ends an open event stream so shutdown does not wait on it", async (_name, _mode, factory) => {
    const project = join(fixtureRoot, "projects", "-tmp-shutdown")
    await mkdir(project, { recursive: true })
    await writeFile(join(project, `${SESSION}.jsonl`), `${JSON.stringify({ type: "user", sessionId: SESSION, message: { role: "user", content: "hi" } })}\n`)
    await writeFile(join(userDataDir, "config.local.json"), JSON.stringify({ claudeDir: fixtureRoot }))
    const { httpServer, dispose } = await factory(staticDir, userDataDir)
    const baseUrl = await listen(httpServer)
    const stream = await fetch(`${baseUrl}/api/watch/-tmp-shutdown/${SESSION}.jsonl`)
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()
    await reader.read()
    const ended = reader.read().then(({ done }) => done, () => true)

    await dispose()

    await expect(ended).resolves.toBe(true)
    expect(httpServer.listening).toBe(false)
    openServers.delete(httpServer)
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

  it("leaves /api/me reachable before configuration, and no path an edition would open", async () => {
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

      // Personal edition has no first-time setup, so nothing past core's own
      // discovery and sign-in paths answers before configuration.
      const setup = await fetch(`${baseUrl}/api/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice", password: "irrelevant" }),
      })
      expect(setup.status).toBe(503)

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

describe("app-server edition resolution", () => {
  const originalEdition = process.env.COGPIT_EDITION

  afterEach(() => {
    if (originalEdition === undefined) delete process.env.COGPIT_EDITION
    else process.env.COGPIT_EDITION = originalEdition
    __resetEditionForTest()
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

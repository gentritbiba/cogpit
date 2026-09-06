// @vitest-environment node
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Middleware } from "../../http"
import { codexBrowserConfig } from "../../agents/codexBrowser"
import { browserAgentEnv, browserPluginPaths, browserShimInstalled } from "../../browser/agentEnv"
import { initBrowserSupport } from "../../browser"
import { binDir, shimPath } from "../../browser/paths"
import { browserUnsupportedReason } from "../../browser/platform"
import { pluginManifestFile } from "../../browser/skill"
import { BrowserViewerManager, defaultViewerSocketDeps } from "../../browser/viewerSocket"
import { defaultBrowserRouteDeps, registerBrowserRoutes } from "../../routes/browser"

const originalPlatform = process.platform
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "browser-platform-"))
  vi.stubEnv("COGPIT_BROWSER_HOME", join(root, "browser"))
  Object.defineProperty(process, "platform", { value: "win32" })
})

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe("managed browser platform support", () => {
  it("supports macOS and Linux and identifies native Windows", () => {
    expect(browserUnsupportedReason("darwin")).toBeNull()
    expect(browserUnsupportedReason("linux")).toBeNull()
    expect(browserUnsupportedReason()).toContain("native Windows")
  })

  it("does not initialize or sweep a browser tree on Windows", async () => {
    const support = initBrowserSupport(vi.fn())
    await support.shutdown()
    expect(existsSync(join(root, "browser"))).toBe(false)
  })

  it("ignores stale shim and plugin files when configuring agents on Windows", async () => {
    mkdirSync(binDir(), { recursive: true })
    writeFileSync(shimPath(), "stale shim")
    const manifest = pluginManifestFile()!
    mkdirSync(dirname(manifest), { recursive: true })
    writeFileSync(manifest, "{}")
    expect(browserShimInstalled()).toBe(false)
    expect(browserPluginPaths()).toEqual([])
    expect(browserAgentEnv({ PATH: "/original" }, "session").PATH).toBe("/original")
    const client = { call: vi.fn() }
    expect(await codexBrowserConfig(client, root)).toEqual({})
    expect(client.call).not.toHaveBeenCalled()
  })

  it("reports unsupported status without probing binaries or browsers", async () => {
    const binary = vi.spyOn(defaultBrowserRouteDeps, "binaryPath")
    const list = vi.spyOn(defaultBrowserRouteDeps, "listBrowsers")
    const response = await request("GET", "/")
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ installed: false, binaryPath: null, sessions: [], unsupportedReason: browserUnsupportedReason() })
    expect(binary).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })

  it.each(["/sessions/default/launch", "/sessions/default/stop", "/skill/install", "/sessions"])("rejects unsupported mutations at %s", async (url) => {
    const response = await request("POST", url)
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: browserUnsupportedReason() })
  })

  it("makes unsupported sockets terminal before probing or accepting launch", () => {
    const installed = vi.spyOn(defaultViewerSocketDeps, "installed")
    const launch = vi.spyOn(defaultViewerSocketDeps, "launch")
    const socket = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn(), close: vi.fn() })
    const manager = new BrowserViewerManager()
    manager.handleConnection(socket as never, { url: "/__browser?session=default" } as never)
    socket.emit("message", Buffer.from(JSON.stringify({ type: "launch", url: "https://example.com" })))
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({ type: "status", state: "unsupported", message: browserUnsupportedReason() })
    expect(installed).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    manager.cleanup()
  })
})

async function request(method: string, url: string): Promise<{ status: number; body: unknown }> {
  let handler: Middleware | undefined
  registerBrowserRoutes((_path, middleware) => { handler = middleware })
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: (body: string) => resolve({ status: response.statusCode, body: JSON.parse(body) }),
    }
    handler!({ method, url } as never, response as never, () => reject(new Error("Unexpected route fallthrough")))
  })
}

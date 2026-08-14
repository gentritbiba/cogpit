// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WebSocket } from "ws"
import type { ViteDevServer } from "vite"

import { ptyPlugin } from "../pty-plugin"
import { hashPassword, createSessionToken, revokeSessionToken, __resetSessionsForTest } from "../security"
import { loadConfig, setConfigPath } from "../config"
import { initEdition, __resetEditionForTest } from "../team/edition"

let root: string
let server: Server | null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogpit-pty-plugin-"))
  server = createServer()
  const configPath = join(root, "config.local.json")
  await mkdir(root, { recursive: true })
  await writeFile(configPath, JSON.stringify({
    claudeDir: root,
    networkAccess: true,
    networkPassword: hashPassword("remote-network-password"),
  }))
  setConfigPath(configPath)
  await loadConfig()
  initEdition({ shell: "dev" })
})

afterEach(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve())
    })
  }
  server = null
  __resetSessionsForTest()
  __resetEditionForTest()
  await rm(root, { recursive: true, force: true })
})

describe("Vite PTY plugin authorization lifecycle", () => {
  it("closes an established remote PTY when its session is revoked", async () => {
    const plugin = ptyPlugin()
    const configure = plugin.configureServer
    if (typeof configure !== "function") throw new Error("Expected configureServer hook")
    await configure({ httpServer: server } as unknown as ViteDevServer)

    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject)
      server!.listen(0, "127.0.0.1", () => resolve())
    })
    const address = server!.address()
    if (!address || typeof address === "string") throw new Error("Expected TCP address")

    const token = createSessionToken("203.0.113.9")
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/__pty?token=${token}`, {
      headers: { "X-Forwarded-For": "203.0.113.9" },
    })
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve)
      ws.once("error", reject)
    })

    const closed = new Promise<number>((resolve) => ws.once("close", resolve))
    await revokeSessionToken(token)
    await expect(closed).resolves.toBe(1008)
  })
})

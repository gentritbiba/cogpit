import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { listenOn, listenOnStablePort } from "../desktopPort"

describe("listenOnStablePort", () => {
  let userDataDir: string
  const servers: Server[] = []

  function server(): Server {
    const created = createServer()
    servers.push(created)
    return created
  }

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "cogpit-desktop-port-"))
  })

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(s => new Promise(resolve => s.close(resolve))))
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it("reuses the port the previous launch bound", async () => {
    const free = await listenOn(server(), 0, "127.0.0.1")
    await new Promise(resolve => servers.pop()!.close(resolve))
    writeFileSync(join(userDataDir, "desktop-port"), String(free))

    const port = await listenOnStablePort(server(), "127.0.0.1", userDataDir)

    expect(port).toBe(free)
  })

  it("falls back to a free port when the remembered one is taken, and remembers it", async () => {
    const taken = await listenOn(server(), 0, "127.0.0.1")
    writeFileSync(join(userDataDir, "desktop-port"), String(taken))

    const port = await listenOnStablePort(server(), "127.0.0.1", userDataDir)

    expect(port).not.toBe(taken)
    expect(port).toBeGreaterThan(0)
    expect(readFileSync(join(userDataDir, "desktop-port"), "utf8")).toBe(String(port))
  })
})

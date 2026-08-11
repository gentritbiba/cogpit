// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startStandaloneServer, type RunningStandaloneServer } from "../standalone-runtime"

const temporaryDirs: string[] = []
const runningServers: RunningStandaloneServer[] = []

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.dispose()))
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cogpit-runtime-"))
  temporaryDirs.push(root)
  const staticDir = join(root, "web")
  const dataDir = join(root, "data")
  const claudeDir = join(root, ".claude")
  await Promise.all([
    mkdir(staticDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(join(claudeDir, "projects"), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(staticDir, "index.html"), "<main>portable cogpit</main>"),
    writeFile(join(dataDir, "config.local.json"), JSON.stringify({ claudeDir })),
  ])
  return { staticDir, dataDir }
}

describe("startStandaloneServer", () => {
  it("binds an available port and serves the app lifecycle", async () => {
    const { staticDir, dataDir } = await fixture()
    const runtime = await startStandaloneServer({
      staticDir,
      dataDir,
      host: "127.0.0.1",
      port: 0,
      env: {},
    })
    runningServers.push(runtime)

    expect(runtime.port).toBeGreaterThan(0)
    expect(runtime.url).toBe(`http://127.0.0.1:${runtime.port}`)

    const [hello, page] = await Promise.all([
      fetch(`${runtime.url}/api/hello`),
      fetch(`${runtime.url}/any/deep/link`),
    ])
    expect(hello.status).toBe(200)
    expect(await hello.json()).toMatchObject({ app: "cogpit", mode: "standalone" })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("portable cogpit")

    await runtime.dispose()
    runningServers.pop()
    await expect(fetch(`${runtime.url}/api/hello`)).rejects.toThrow()
  })

  it("refuses a passwordless non-loopback bind before listening", async () => {
    const { staticDir, dataDir } = await fixture()
    await expect(startStandaloneServer({
      staticDir,
      dataDir,
      host: "0.0.0.0",
      port: 0,
      env: {},
    })).rejects.toThrow("Refusing to bind")
  })
})

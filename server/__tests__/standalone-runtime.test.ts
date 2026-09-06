// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startStandaloneServer, type RunningStandaloneServer } from "../standalone-runtime"

const temporaryDirs: string[] = []
const runningServers: RunningStandaloneServer[] = []

/**
 * Starting the server installs the browser shim, the plugin and the per-CLI
 * skill. Both homes are read from the process env, so they are pinned inside a
 * fixture — otherwise the suite writes into the developer's ~/.cogpit and
 * ~/.claude.
 */
let previousBrowserHome: string | undefined
let previousSkillHome: string | undefined

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "cogpit-runtime-home-"))
  temporaryDirs.push(root)
  previousBrowserHome = process.env.COGPIT_BROWSER_HOME
  previousSkillHome = process.env.COGPIT_SKILL_HOME
  process.env.COGPIT_BROWSER_HOME = join(root, "browser")
  process.env.COGPIT_SKILL_HOME = join(root, "home")
})

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.dispose()))
  if (previousBrowserHome === undefined) delete process.env.COGPIT_BROWSER_HOME
  else process.env.COGPIT_BROWSER_HOME = previousBrowserHome
  if (previousSkillHome === undefined) delete process.env.COGPIT_SKILL_HOME
  else process.env.COGPIT_SKILL_HOME = previousSkillHome
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture(config: Record<string, unknown> = {}) {
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
    writeFile(join(dataDir, "config.local.json"), JSON.stringify({ claudeDir, ...config })),
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

  it("preserves team-edition boot policy in the reusable runtime", async () => {
    const { staticDir, dataDir } = await fixture({ edition: "team" })
    const runtime = await startStandaloneServer({
      staticDir,
      dataDir,
      host: "127.0.0.1",
      port: 0,
      // Team members authenticate individually, so the shared password is
      // ignored rather than rejected for being weak or applied to the config.
      env: { COGPIT_NETWORK_PASSWORD: "weak" },
    })
    runningServers.push(runtime)

    const hello = await fetch(`${runtime.url}/api/hello`)
    expect(hello.status).toBe(200)
    expect(await hello.json()).toMatchObject({
      edition: "team",
      needsBootstrap: true,
    })
    expect(runtime.envPassword).toBe(true)
  })
})

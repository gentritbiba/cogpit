import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer as createViteServer } from "vite"
import { afterEach, beforeEach } from "vitest"

import { sessionApiPlugin } from "../api-plugin"
import { createServerComposition } from "../app-server"
import { setConfigPath, setDataRoot } from "../config"

/** Real server compositions on loopback, for the app-server tests of every edition. */

const compositions = new Map<Server, () => Promise<void>>()
async function createComposition(staticDir: string, userDataDir: string, mode: "electron" | "standalone") {
  const composition = await createServerComposition(staticDir, userDataDir, { mode, viteDevUrl: process.env.ELECTRON_RENDERER_URL })
  const dispose = async () => {
    await composition.dispose()
    compositions.delete(composition.httpServer)
    openServers.delete(composition.httpServer)
  }
  compositions.set(composition.httpServer, dispose)
  return { ...composition, dispose }
}
export const createAppServer = (staticDir: string, userDataDir: string) => createComposition(staticDir, userDataDir, "electron")
export const createStandaloneAppServer = (staticDir: string, userDataDir: string) => createComposition(staticDir, userDataDir, "standalone")

/**
 * The Vite dev shell: the session API plugin in a real Vite dev server over
 * `staticDir`, SPA fallback included. That shell keeps its config and data in
 * the checkout, so both are pointed at `userDataDir` first.
 */
export async function createDevAppServer(staticDir: string, userDataDir: string) {
  setDataRoot(userDataDir)
  setConfigPath(join(userDataDir, "config.local.json"))
  const vite = await createViteServer({
    configFile: false,
    root: staticDir,
    cacheDir: join(userDataDir, "vite"),
    appType: "spa",
    logLevel: "silent",
    plugins: [sessionApiPlugin()],
    server: { hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  })
  const httpServer = vite.httpServer
  if (!(httpServer instanceof Server)) throw new Error("Expected Vite to create an HTTP server")
  const dispose = async () => {
    await vite.close()
    compositions.delete(httpServer)
    openServers.delete(httpServer)
  }
  compositions.set(httpServer, dispose)
  return { httpServer, dispose }
}

export const openServers = new Set<Server>()
export let fixtureRoot: string
export let staticDir: string
export let userDataDir: string
let previousBrowserHome: string | undefined
let previousSkillHome: string | undefined

export async function listen(server: Server): Promise<string> {
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

export async function close(server: Server): Promise<void> {
  const dispose = compositions.get(server)
  if (dispose) {
    await dispose()
    return
  }
  if (!server.listening) {
    openServers.delete(server)
    return
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  openServers.delete(server)
}

/**
 * A fresh static root and user-data directory per test, with the browser and
 * skill homes kept inside it, and every server the test opened closed after it.
 */
export function useAppServerFixture(): void {
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
    await Promise.all([...new Set([...openServers, ...compositions.keys()])].map(close))
    delete process.env.ELECTRON_RENDERER_URL
    if (previousBrowserHome === undefined) delete process.env.COGPIT_BROWSER_HOME
    else process.env.COGPIT_BROWSER_HOME = previousBrowserHome
    if (previousSkillHome === undefined) delete process.env.COGPIT_SKILL_HOME
    else process.env.COGPIT_SKILL_HOME = previousSkillHome
    await rm(fixtureRoot, { recursive: true, force: true })
  })
}

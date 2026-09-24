import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach } from "vitest"

import { __resetEditionForTest } from "../edition"
import type { RunningStandaloneServer } from "../standalone-runtime"

/** Standalone runtimes on loopback with their own data directories, for every edition's tests. */

const temporaryDirs: string[] = []
export const runningServers: RunningStandaloneServer[] = []

/**
 * Starting the server installs the browser shim, the plugin and the per-CLI
 * skill. Both homes are read from the process env, so they are pinned inside a
 * fixture — otherwise the suite writes into the developer's ~/.cogpit and
 * ~/.claude.
 */
let previousBrowserHome: string | undefined
let previousSkillHome: string | undefined

export function useStandaloneRuntimeFixture(): void {
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
    __resetEditionForTest()
    if (previousBrowserHome === undefined) delete process.env.COGPIT_BROWSER_HOME
    else process.env.COGPIT_BROWSER_HOME = previousBrowserHome
    if (previousSkillHome === undefined) delete process.env.COGPIT_SKILL_HOME
    else process.env.COGPIT_SKILL_HOME = previousSkillHome
    await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })
}

export async function fixture(config: Record<string, unknown> = {}) {
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

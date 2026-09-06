// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `failures` names the step a test wants to break; the mocks below delegate to
 * the real modules for every other step, so a tolerance test still exercises
 * the code around the one that threw.
 */
const { failures, record } = vi.hoisted(() => ({
  failures: new Set<string>(),
  record: { sweepersStarted: 0, sweepersStopped: 0, browserShutdowns: 0 },
}))

vi.mock("../../browser/shim", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../browser/shim")>()
  return {
    ...actual,
    findRealAgentBrowser: (env?: NodeJS.ProcessEnv) => {
      if (failures.has("find")) throw new Error("PATH scan failed")
      return actual.findRealAgentBrowser(env)
    },
    ensureShim: (realBinary: string | null) => {
      if (failures.has("shim")) throw new Error("shim write failed")
      return actual.ensureShim(realBinary)
    },
  }
})

vi.mock("../../browser/skill", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../browser/skill")>()
  return {
    ...actual,
    ensurePlugin: () => {
      if (failures.has("plugin")) throw new Error("plugin write failed")
      return actual.ensurePlugin()
    },
  }
})

vi.mock("../../browser/daemons", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../browser/daemons")>()
  return {
    ...actual,
    startSweeper: (isLive: (id: string) => boolean) => {
      if (failures.has("sweeper")) throw new Error("sweeper failed")
      const stop = actual.startSweeper(isLive)
      record.sweepersStarted += 1
      return () => {
        record.sweepersStopped += 1
        stop()
      }
    },
    shutdownBrowsers: async () => {
      record.browserShutdowns += 1
      if (failures.has("shutdown")) throw new Error("daemon shutdown failed")
    },
  }
})

import { initBrowserSupport } from "../../browser"
import { pluginManifestFile, pluginSkillFile } from "../../browser/skill"
import { profilesDir, sharedRunDir, shimPath } from "../../browser/paths"

let root = ""
let realBinary = ""
let previousHome: string | undefined
let previousPath: string | undefined
let errors: unknown[][] = []

const alwaysDead = () => false

beforeEach(() => {
  failures.clear()
  record.sweepersStarted = 0
  record.sweepersStopped = 0
  record.browserShutdowns = 0
  errors = []
  previousHome = process.env.COGPIT_BROWSER_HOME
  previousPath = process.env.PATH
  root = mkdtempSync(join(tmpdir(), "cogpit-browser-"))
  process.env.COGPIT_BROWSER_HOME = join(root, "browser")

  // A stand-in for an installed agent-browser, reachable only through PATH.
  const binDir = join(root, "path")
  mkdirSync(binDir, { recursive: true })
  realBinary = join(binDir, "agent-browser")
  writeFileSync(realBinary, "#!/usr/bin/env bash\n", { mode: 0o755 })
  process.env.PATH = binDir

  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args) })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (previousHome === undefined) delete process.env.COGPIT_BROWSER_HOME
  else process.env.COGPIT_BROWSER_HOME = previousHome
  if (previousPath === undefined) delete process.env.PATH
  else process.env.PATH = previousPath
  rmSync(root, { recursive: true, force: true })
})

describe("initBrowserSupport", () => {
  it("creates the tree, installs the shim and plugin, and starts a sweeper", async () => {
    const support = initBrowserSupport(alwaysDead)

    expect(statSync(profilesDir()).isDirectory()).toBe(true)
    expect(statSync(sharedRunDir()).isDirectory()).toBe(true)
    expect(readFileSync(shimPath(), "utf8")).toContain(`real="${realBinary}"`)
    expect(statSync(shimPath()).mode & 0o111).not.toBe(0)
    expect(JSON.parse(readFileSync(pluginManifestFile(), "utf8")).name).toBe("cogpit")
    expect(readFileSync(pluginSkillFile(), "utf8")).toContain("name: cogpit-browser")
    expect(record.sweepersStarted).toBe(1)
    expect(errors).toEqual([])

    await support.shutdown()
  })

  it("removes a stale shim when no agent-browser is installed", async () => {
    process.env.PATH = join(root, "empty")
    const support = initBrowserSupport(alwaysDead)

    expect(existsSync(shimPath())).toBe(false)
    expect(errors).toEqual([])

    await support.shutdown()
  })

  it("sweeps the run directory of a session that is no longer live", async () => {
    const live = join(root, "browser", "run", "alive")
    const dead = join(root, "browser", "run", "gone")
    mkdirSync(live, { recursive: true })
    mkdirSync(dead, { recursive: true })

    const support = initBrowserSupport((id) => id === "alive")

    expect(existsSync(live)).toBe(true)
    expect(existsSync(dead)).toBe(false)

    await support.shutdown()
  })

  it.each([
    ["find", "PATH scan failed"],
    ["shim", "shim write failed"],
    ["plugin", "plugin write failed"],
    ["sweeper", "sweeper failed"],
  ])("logs and continues when the %s step throws", async (step, message) => {
    failures.add(step)

    const support = initBrowserSupport(alwaysDead)

    expect(errors).toHaveLength(1)
    expect((errors[0][1] as Error).message).toBe(message)

    await expect(support.shutdown()).resolves.toBeUndefined()
    expect(record.browserShutdowns).toBe(1)
  })

  it("survives a browser home it cannot create", async () => {
    const blocker = join(root, "blocker")
    writeFileSync(blocker, "not a directory")
    process.env.COGPIT_BROWSER_HOME = join(blocker, "browser")

    const support = initBrowserSupport(alwaysDead)

    expect(errors.length).toBeGreaterThan(0)
    await expect(support.shutdown()).resolves.toBeUndefined()
  })
})

describe("BrowserSupport.shutdown", () => {
  it("stops the sweeper and shuts the daemons down", async () => {
    const support = initBrowserSupport(alwaysDead)

    await support.shutdown()

    expect(record.sweepersStopped).toBe(1)
    expect(record.browserShutdowns).toBe(1)
  })

  it("stops the sweeper once even when called twice", async () => {
    const support = initBrowserSupport(alwaysDead)

    await support.shutdown()
    await support.shutdown()

    expect(record.sweepersStopped).toBe(1)
    expect(record.browserShutdowns).toBe(2)
  })

  it("reports a failed daemon shutdown instead of rejecting", async () => {
    failures.add("shutdown")
    const support = initBrowserSupport(alwaysDead)

    await expect(support.shutdown()).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect((errors[0][1] as Error).message).toBe("daemon shutdown failed")
  })
})

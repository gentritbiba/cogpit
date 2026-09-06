// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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
    installSkillEverywhere: () => {
      if (failures.has("skill")) throw new Error("skill install failed")
      return actual.installSkillEverywhere()
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
import { pluginManifestFile, pluginSkillFile, SKILL_NAME } from "../../browser/skill"
import { profilesDir, sharedRunDir, shimPath } from "../../browser/paths"
import { AGENT_KINDS, descriptorFor } from "../../../shared/session/agent-descriptors"

let root = ""
let realBinary = ""
let skillHome = ""
let previousHome: string | undefined
let previousSkillHome: string | undefined
let previousPath: string | undefined
let errors: unknown[][] = []

/** Non-null unless no CLI takes a plugin at all, which the descriptor table rules out. */
function manifestFile(): string {
  const path = pluginManifestFile()
  if (path === null) throw new Error("No agent CLI takes a plugin")
  return path
}

/** Where the startup installer would put the skill, one entry per CLI that reads skills. */
function skillTargets(): { configRoot: string; dir: string; skill: string }[] {
  return AGENT_KINDS.flatMap((kind) => {
    const { rootDirName, skillsDir } = descriptorFor(kind).config
    if (skillsDir === null) return []
    const configRoot = join(skillHome, rootDirName)
    const dir = join(configRoot, skillsDir, SKILL_NAME)
    return [{ configRoot, dir, skill: join(dir, "SKILL.md") }]
  })
}

function giveTheUserEveryCli(): void {
  for (const { configRoot } of skillTargets()) mkdirSync(configRoot, { recursive: true })
}

const alwaysDead = () => false

beforeEach(() => {
  failures.clear()
  record.sweepersStarted = 0
  record.sweepersStopped = 0
  record.browserShutdowns = 0
  errors = []
  previousHome = process.env.COGPIT_BROWSER_HOME
  previousSkillHome = process.env.COGPIT_SKILL_HOME
  previousPath = process.env.PATH
  root = mkdtempSync(join(tmpdir(), "cogpit-browser-"))
  skillHome = join(root, "home")
  process.env.COGPIT_BROWSER_HOME = join(root, "browser")
  process.env.COGPIT_SKILL_HOME = skillHome

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
  if (previousSkillHome === undefined) delete process.env.COGPIT_SKILL_HOME
  else process.env.COGPIT_SKILL_HOME = previousSkillHome
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
    expect(JSON.parse(readFileSync(manifestFile(), "utf8")).name).toBe("cogpit")
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

  it("installs the skill into every CLI the user has, not just the one that takes the plugin", async () => {
    giveTheUserEveryCli()

    const support = initBrowserSupport(alwaysDead)

    expect(skillTargets().length).toBeGreaterThan(1)
    for (const { skill } of skillTargets()) {
      expect(readFileSync(skill, "utf8")).toContain("name: cogpit-browser")
    }
    expect(errors).toEqual([])

    await support.shutdown()
  })

  it("keeps installing for the other CLIs when one of them cannot be written", async () => {
    giveTheUserEveryCli()
    const [blocked, ...rest] = skillTargets()
    expect(rest.length).toBeGreaterThan(0)
    // A file where the skill directory has to go: this write throws, the rest do not.
    mkdirSync(dirname(blocked.dir), { recursive: true })
    writeFileSync(blocked.dir, "not a directory")

    const support = initBrowserSupport(alwaysDead)

    expect(errors).toHaveLength(1)
    for (const { skill } of rest) expect(readFileSync(skill, "utf8")).toContain("name: cogpit-browser")

    await support.shutdown()
  })

  it("leaves an unchanged skill file alone on a second start", async () => {
    giveTheUserEveryCli()
    await initBrowserSupport(alwaysDead).shutdown()
    const written = new Date(Date.now() - 60_000)
    for (const { skill } of skillTargets()) utimesSync(skill, written, written)
    const before = skillTargets().map(({ skill }) => statSync(skill).mtimeMs)

    const support = initBrowserSupport(alwaysDead)

    expect(skillTargets().map(({ skill }) => statSync(skill).mtimeMs)).toEqual(before)

    await support.shutdown()
  })

  it.each([
    ["find", "PATH scan failed"],
    ["shim", "shim write failed"],
    ["plugin", "plugin write failed"],
    ["skill", "skill install failed"],
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

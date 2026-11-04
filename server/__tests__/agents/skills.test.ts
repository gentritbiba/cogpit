// @vitest-environment node
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AGENT_KINDS, descriptorFor } from "../../../shared/session/agent-descriptors"
import { COGPIT_SKILL_FILES } from "../../agents/bundledSkills"
import { RETIRED_SKILL_DIRS, RETIRED_SKILL_FILES } from "../../agents/retiredSkillFiles"
import { COGPIT_SKILL, installCogpitSkill, installSkill, installSkillEverywhere, skillConfigRoot, skillTargets } from "../../agents/skills"
import { installSessionCli } from "../../sessionCli/install"

/** Stand-in content for each retired file, so the tests need no copy of a real old release. */
const { oldContent } = vi.hoisted(() => ({ oldContent: (file: string) => `old ${file}` }))

vi.mock("../../agents/retiredSkillFiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/retiredSkillFiles")>()
  const { createHash } = await import("node:crypto")
  return {
    ...actual,
    RETIRED_SKILL_FILES: Object.fromEntries(Object.keys(actual.RETIRED_SKILL_FILES)
      .map((file) => [file, [createHash("sha256").update(oldContent(file)).digest("hex")]])),
  }
})

let root: string
let errors: unknown[][]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cogpit-skills-"))
  vi.stubEnv("COGPIT_SKILL_HOME", join(root, "home"))
  vi.stubEnv("COGPIT_BROWSER_HOME", join(root, "browser"))
  errors = []
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args) })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

const kinds = AGENT_KINDS.filter((kind) => descriptorFor(kind).config.skillsDir !== null)
function skillsDir(kind = kinds[0]) {
  return join(skillConfigRoot(kind), descriptorFor(kind).config.skillsDir!)
}
function directory(kind = kinds[0]) {
  return join(skillsDir(kind), COGPIT_SKILL)
}
function giveRoots() { for (const kind of kinds) mkdirSync(skillConfigRoot(kind), { recursive: true }) }
function expectCurrent(dir: string) {
  for (const [file, content] of Object.entries(COGPIT_SKILL_FILES)) expect(readFileSync(join(dir, file), "utf8")).toBe(content)
}

function writeOldCopy(skills: string, file: string, as = file) {
  const path = join(skills, as)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, oldContent(file))
}

describe("the cogpit skill", () => {
  it("is one layered skill whose index links every reference", () => {
    const index = COGPIT_SKILL_FILES["SKILL.md"]
    expect(index).toMatch(/^---\nname: cogpit\ndescription: \S/)
    const references = Object.keys(COGPIT_SKILL_FILES).filter((file) => file.startsWith("references/"))
    const linked = new Set([...Object.values(COGPIT_SKILL_FILES).join("\n").matchAll(/\]\(((?:references\/)?[\w-]+\.md)\)/g)]
      .map(([, target]) => target.startsWith("references/") ? target : `references/${target}`))
    for (const reference of references) expect(linked, reference).toContain(reference)
    for (const target of linked) expect(COGPIT_SKILL_FILES, target).toHaveProperty([target])
  })

  it("keeps the entry point short so an agent reads only the layer it needs", () => {
    expect(COGPIT_SKILL_FILES["SKILL.md"].split("\n").length).toBeLessThan(60)
  })
})

describe("installCogpitSkill", () => {
  it("installs the skill and its references on startup without a browser executable", () => {
    giveRoots()
    installSessionCli()
    for (const kind of kinds) expectCurrent(directory(kind))
  })

  it("refreshes old content after an update and leaves unchanged and unrelated files alone", () => {
    giveRoots()
    installSessionCli()
    const entry = join(directory(), "SKILL.md")
    const reference = join(directory(), "references/sessions.md")
    const custom = join(directory(), "my-notes.md")
    writeFileSync(entry, "old release")
    writeFileSync(custom, "user notes")
    const age = new Date(1000)
    utimesSync(reference, age, age)
    installSessionCli()
    expect(readFileSync(entry, "utf8")).toBe(COGPIT_SKILL_FILES["SKILL.md"])
    expect(statSync(reference).mtimeMs).toBe(age.getTime())
    expect(readFileSync(custom, "utf8")).toBe("user notes")
  })

  it("skips absent agent config roots", () => {
    expect(installCogpitSkill()).toEqual({ installed: [], failed: [] })
    expect(existsSync(join(root, "home"))).toBe(false)
  })

  it("still refreshes the skill when the CLI launcher cannot be written", () => {
    giveRoots()
    writeFileSync(join(root, "bin"), "blocked")
    installSessionCli()
    expect(errors.length).toBeGreaterThan(0)
    expectCurrent(directory())
  })

  it("keeps installing for other agents after a write failure", () => {
    giveRoots()
    const blocked = directory()
    mkdirSync(skillsDir(), { recursive: true })
    writeFileSync(blocked, "blocked")
    const { installed, failed } = installCogpitSkill()
    expect(errors.length).toBeGreaterThan(0)
    expect(failed).toEqual([blocked])
    expect(installed).toContain(directory(kinds[1]))
  })

  it.skipIf(process.platform === "win32")("updates a linked source without replacing its symlink", () => {
    giveRoots()
    mkdirSync(directory(), { recursive: true })
    const source = join(root, "source.md")
    writeFileSync(source, "old")
    const link = join(directory(), "SKILL.md")
    symlinkSync(source, link)
    installCogpitSkill()
    expect(readFileSync(source, "utf8")).toBe(COGPIT_SKILL_FILES["SKILL.md"])
    writeFileSync(source, "changed source")
    expect(readFileSync(link, "utf8")).toBe("changed source")
  })

  it("installs only the selected provider account and honors its home override", () => {
    vi.stubEnv("COGPIT_SKILL_HOME", "")
    const kind = kinds.find((kind) => descriptorFor(kind).cli.homeEnvVar !== null)!
    const home = join(root, "account")
    mkdirSync(home)
    vi.stubEnv(descriptorFor(kind).cli.homeEnvVar!, home)
    expect(skillConfigRoot(kind)).toBe(home)
    const { installed } = installCogpitSkill([kind])
    expect(installed).toEqual([join(home, descriptorFor(kind).config.skillsDir!, COGPIT_SKILL)])
  })

  it("also installs into the home an SDK session inherits when it differs from the configured one", () => {
    vi.stubEnv("COGPIT_SKILL_HOME", "")
    const kind = kinds.find((kind) => descriptorFor(kind).cli.sdkHomeEnvVar !== undefined)!
    const { cli, config } = descriptorFor(kind)
    const home = join(root, "user")
    const sdkHome = join(root, "sdk-home")
    mkdirSync(join(home, cli.homeDirName), { recursive: true })
    mkdirSync(sdkHome)
    vi.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", home)
    vi.stubEnv(cli.sdkHomeEnvVar!, sdkHome)
    const { installed } = installCogpitSkill([kind])
    expect(installed).toEqual([
      join(home, cli.homeDirName, config.skillsDir!, COGPIT_SKILL),
      join(sdkHome, config.skillsDir!, COGPIT_SKILL),
    ])
    for (const directory of installed) expectCurrent(directory)
  })
})

describe("retiring the skills folded into cogpit", () => {
  it("lists only files this release no longer ships, inside the directories it removes", async () => {
    const actual = await vi.importActual<typeof import("../../agents/retiredSkillFiles")>("../../agents/retiredSkillFiles")
    for (const [file, hashes] of Object.entries(actual.RETIRED_SKILL_FILES)) {
      expect(hashes.length).toBeGreaterThan(0)
      for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/)
      if (file.startsWith(`${COGPIT_SKILL}/`)) expect(COGPIT_SKILL_FILES).not.toHaveProperty([file.slice(COGPIT_SKILL.length + 1)])
      else expect(RETIRED_SKILL_DIRS).toContain(file.split("/")[0])
    }
  })

  it("removes unmodified copies an older release installed, and their directories", () => {
    giveRoots()
    for (const file of Object.keys(RETIRED_SKILL_FILES)) writeOldCopy(skillsDir(), file)
    installCogpitSkill()
    expect(readdirSync(skillsDir())).toEqual([COGPIT_SKILL])
    expect(existsSync(join(directory(), "references/cogpit-sessions.md"))).toBe(false)
    expectCurrent(directory())
    expect(errors).toEqual([])
  })

  it("keeps a copy the user changed, and anything they added", () => {
    giveRoots()
    writeOldCopy(skillsDir(), "cogpit-browser/SKILL.md")
    writeOldCopy(skillsDir(), "cogpit-browser/references/advanced.md")
    writeFileSync(join(skillsDir(), "cogpit-browser/references/advanced.md"), "my edits")
    writeOldCopy(skillsDir(), "cogpit-memory/SKILL.md")
    writeFileSync(join(skillsDir(), "cogpit-memory/notes.md"), "mine")
    installCogpitSkill()
    expect(existsSync(join(skillsDir(), "cogpit-browser/SKILL.md"))).toBe(false)
    expect(readFileSync(join(skillsDir(), "cogpit-browser/references/advanced.md"), "utf8")).toBe("my edits")
    expect(existsSync(join(skillsDir(), "cogpit-memory/SKILL.md"))).toBe(false)
    expect(readFileSync(join(skillsDir(), "cogpit-memory/notes.md"), "utf8")).toBe("mine")
  })

  it.skipIf(process.platform === "win32")("never deletes through a link, and drops links left dangling", () => {
    giveRoots()
    for (const kind of kinds) mkdirSync(skillsDir(kind), { recursive: true })
    const source = join(root, "repo-skill")
    writeOldCopy(source, "cogpit-sessions/SKILL.md", "SKILL.md")
    symlinkSync(source, join(skillsDir(), "cogpit-sessions"))
    // The first CLI links to the second's copy, so the link is visited before the copy goes.
    writeOldCopy(skillsDir(kinds[1]), "cogpit-memory/SKILL.md")
    symlinkSync(join(skillsDir(kinds[1]), "cogpit-memory"), join(skillsDir(), "cogpit-memory"))
    installCogpitSkill()
    expect(readFileSync(join(source, "SKILL.md"), "utf8")).toBe(oldContent("cogpit-sessions/SKILL.md"))
    expect(lstatSync(join(skillsDir(), "cogpit-sessions")).isSymbolicLink()).toBe(true)
    expect(existsSync(join(skillsDir(kinds[1]), "cogpit-memory"))).toBe(false)
    expect(lstatSync(join(skillsDir(), "cogpit-memory"), { throwIfNoEntry: false })).toBeUndefined()
  })

  it.skipIf(process.platform === "win32")("keeps a broken link the cleanup did not cause", () => {
    giveRoots()
    mkdirSync(skillsDir(), { recursive: true })
    const link = join(skillsDir(), "cogpit-memory")
    symlinkSync(join(root, "offline", "cogpit-memory"), link)
    installCogpitSkill()
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
  })
})

describe("installSkill", () => {
  it("installs into the config root of a target, creating it", () => {
    for (const kind of kinds) {
      expect(installSkill(kind)).toBe(directory(kind))
      expectCurrent(directory(kind))
    }
  })

  it("overwrites an older copy", () => {
    const dir = installSkill(kinds[0])
    writeFileSync(join(dir, "SKILL.md"), "stale")
    installSkill(kinds[0])
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe(COGPIT_SKILL_FILES["SKILL.md"])
  })

  it("falls back to the real home when no override is set", () => {
    vi.stubEnv("COGPIT_SKILL_HOME", "")
    const home = join(root, "fallback")
    mkdirSync(home)
    vi.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", home)
    const dir = installSkill("claude")
    expect(dir.startsWith(home)).toBe(true)
    expect(existsSync(join(dir, "SKILL.md"))).toBe(true)
  })
})

describe("skillTargets", () => {
  it("lists every CLI that reads skills, with the config root an install writes into", () => {
    const targets = skillTargets()
    expect(targets.map((target) => target.kind)).toEqual(kinds)
    for (const target of targets) {
      expect(target.label).toBe(descriptorFor(target.kind).displayName)
      expect(target.configRoot).toBe(skillConfigRoot(target.kind))
      expect(target.installed).toBe(false)
      expect(target.automatic).toBe(false)
    }
  })

  it("calls a target installed only while every file matches the current skill", () => {
    const dir = installSkill(kinds[0])
    expect(skillTargets()[0].installed).toBe(true)
    rmSync(join(dir, "references"), { recursive: true })
    expect(skillTargets()[0].installed).toBe(false)
    installSkill(kinds[0])
    writeFileSync(join(dir, "SKILL.md"), "an older skill")
    expect(skillTargets()[0].installed).toBe(false)
  })

  it("marks every existing CLI config as receiving the launch refresh", () => {
    giveRoots()
    expect(skillTargets().every((target) => target.automatic)).toBe(true)
  })
})

describe("installSkillEverywhere", () => {
  it("writes into every config root that exists and skips the rest", () => {
    mkdirSync(skillConfigRoot(kinds[0]), { recursive: true })
    expect(installSkillEverywhere()).toEqual([directory(kinds[0])])
    for (const kind of kinds.slice(1)) expect(existsSync(skillConfigRoot(kind))).toBe(false)
  })

  it("installs the rest and reports when one CLI cannot be written", () => {
    giveRoots()
    mkdirSync(skillsDir(), { recursive: true })
    writeFileSync(directory(), "not a directory")
    expect(() => installSkillEverywhere()).toThrow(/did not reach/)
    for (const kind of kinds.slice(1)) expectCurrent(directory(kind))
  })

  it("leaves an unchanged file alone on a second run", () => {
    giveRoots()
    installSkillEverywhere()
    const age = new Date(1000)
    for (const kind of kinds) utimesSync(join(directory(kind), "SKILL.md"), age, age)
    installSkillEverywhere()
    for (const kind of kinds) expect(statSync(join(directory(kind), "SKILL.md")).mtimeMs).toBe(age.getTime())
  })
})

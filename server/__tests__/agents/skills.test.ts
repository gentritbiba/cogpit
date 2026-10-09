// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AGENT_KINDS, descriptorFor } from "../../../shared/session/agent-descriptors"
import { BUNDLED_SKILLS } from "../../agents/bundledSkills"
import { installBundledSkills, skillConfigRoot } from "../../agents/skills"
import { ensurePlugin } from "../../browser/skill"
import { pluginDir } from "../../browser/paths"
import { installSessionCli } from "../../sessionCli/install"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cogpit-skills-"))
  vi.stubEnv("COGPIT_SKILL_HOME", join(root, "home"))
  vi.stubEnv("COGPIT_BROWSER_HOME", join(root, "browser"))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

const kinds = AGENT_KINDS.filter((kind) => descriptorFor(kind).config.skillsDir !== null)
function directory(kind = kinds[0], name = "cogpit") {
  return join(skillConfigRoot(kind), descriptorFor(kind).config.skillsDir!, name)
}
function giveRoots() { for (const kind of kinds) mkdirSync(skillConfigRoot(kind), { recursive: true }) }

describe("bundled skills", () => {
  it("installs every skill and its references on startup without a browser executable", () => {
    giveRoots()
    installSessionCli()
    for (const kind of kinds) for (const [name, files] of Object.entries(BUNDLED_SKILLS)) {
      for (const [file, content] of Object.entries(files)) expect(readFileSync(join(directory(kind, name), file), "utf8")).toBe(content)
    }
  })

  it("refreshes old content after an update and leaves unchanged and unrelated files alone", () => {
    giveRoots()
    installSessionCli()
    const entry = join(directory(), "SKILL.md")
    const reference = join(directory(), "references/cogpit-sessions.md")
    const custom = join(directory(), "my-notes.md")
    writeFileSync(entry, "old release")
    writeFileSync(custom, "user notes")
    const age = new Date(1000)
    utimesSync(reference, age, age)
    installSessionCli()
    expect(readFileSync(entry, "utf8")).toBe(BUNDLED_SKILLS.cogpit["SKILL.md"])
    expect(statSync(reference).mtimeMs).toBe(age.getTime())
    expect(readFileSync(custom, "utf8")).toBe("user notes")
  })

  it("skips absent agent config roots", () => {
    expect(installBundledSkills()).toEqual([])
    expect(existsSync(join(root, "home"))).toBe(false)
  })

  it("still refreshes skills when the CLI launcher cannot be written", () => {
    giveRoots()
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, "bin"), "blocked")
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    installSessionCli()
    expect(errors).toHaveBeenCalled()
    expect(readFileSync(join(directory(), "SKILL.md"), "utf8")).toBe(BUNDLED_SKILLS.cogpit["SKILL.md"])
  })

  it("keeps installing other skills and agents after a write failure", () => {
    giveRoots()
    const blocked = directory()
    mkdirSync(join(blocked, ".."), { recursive: true })
    writeFileSync(blocked, "blocked")
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const installed = installBundledSkills()
    expect(errors).toHaveBeenCalled()
    expect(installed).not.toContain(blocked)
    expect(installed).toContain(directory(kinds[0], "cogpit-sessions"))
    expect(installed).toContain(directory(kinds[1]))
  })

  it.skipIf(process.platform === "win32")("updates a linked source without replacing its symlink", () => {
    giveRoots()
    mkdirSync(directory(), { recursive: true })
    const source = join(root, "source.md")
    writeFileSync(source, "old")
    const link = join(directory(), "SKILL.md")
    symlinkSync(source, link)
    installBundledSkills()
    expect(readFileSync(source, "utf8")).toBe(BUNDLED_SKILLS.cogpit["SKILL.md"])
    writeFileSync(source, "changed source")
    expect(readFileSync(link, "utf8")).toBe("changed source")
  })

  it("ships the same skills and references through the runtime plugin", () => {
    ensurePlugin()
    for (const [name, files] of Object.entries(BUNDLED_SKILLS)) for (const [file, content] of Object.entries(files)) {
      expect(readFileSync(join(pluginDir(), "skills", name, file), "utf8")).toBe(content)
    }
  })

  it("installs only the selected provider account and honors its home override", () => {
    vi.stubEnv("COGPIT_SKILL_HOME", "")
    const kind = kinds.find((kind) => descriptorFor(kind).cli.homeEnvVar !== null)!
    const home = join(root, "account")
    mkdirSync(home)
    vi.stubEnv(descriptorFor(kind).cli.homeEnvVar!, home)
    expect(skillConfigRoot(kind)).toBe(home)
    const installed = installBundledSkills([kind])
    expect(installed).toHaveLength(Object.keys(BUNDLED_SKILLS).length)
    expect(installed.every((path) => path.startsWith(home))).toBe(true)
  })
})

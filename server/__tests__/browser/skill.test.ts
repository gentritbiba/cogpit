// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { pluginDir } from "../../browser/paths"
import {
  COGPIT_BROWSER_SKILL,
  ensurePlugin,
  installSkill,
  PLUGIN_MANIFEST,
  pluginManifestFile,
  pluginSkillFile,
  SKILL_NAME,
} from "../../browser/skill"

let root = ""
let previousHome: string | undefined
let previousSkillHome: string | undefined

beforeEach(() => {
  previousHome = process.env.COGPIT_BROWSER_HOME
  previousSkillHome = process.env.COGPIT_SKILL_HOME
  root = mkdtempSync(join(tmpdir(), "cogpit-browser-"))
  process.env.COGPIT_BROWSER_HOME = join(root, "browser")
  process.env.COGPIT_SKILL_HOME = join(root, "home")
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.COGPIT_BROWSER_HOME
  else process.env.COGPIT_BROWSER_HOME = previousHome
  if (previousSkillHome === undefined) delete process.env.COGPIT_SKILL_HOME
  else process.env.COGPIT_SKILL_HOME = previousSkillHome
  rmSync(root, { recursive: true, force: true })
})

const AGE = new Date(Date.now() - 60_000)

describe("COGPIT_BROWSER_SKILL", () => {
  it("declares the skill in frontmatter with a description", () => {
    const lines = COGPIT_BROWSER_SKILL.split("\n")
    expect(lines[0]).toBe("---")
    expect(lines[1]).toBe(`name: ${SKILL_NAME}`)
    expect(lines[2]).toMatch(/^description: \S/)
    expect(lines[3]).toBe("---")
  })

  it("makes the throwaway rule for subagents explicit", () => {
    expect(COGPIT_BROWSER_SKILL).toContain("--session tmp-")
    expect(COGPIT_BROWSER_SKILL).toMatch(/subagent, you MUST use `--session tmp-/)
    expect(COGPIT_BROWSER_SKILL).toMatch(/Never touch `default` or a named browser from a subagent/)
    expect(COGPIT_BROWSER_SKILL).toContain("close")
  })

  it("lists the flags Cogpit owns", () => {
    for (const flag of ["--profile", "--state", "--session-name", "--args", "--headed", "--cdp"]) {
      expect(COGPIT_BROWSER_SKILL).toContain(flag)
    }
  })

  it("resolves the server port the way the sessions skill does", () => {
    expect(COGPIT_BROWSER_SKILL).toContain('PORT="${COGPIT_PORT:-$(cat ~/.cogpit/port 2>/dev/null || echo 19384)}"')
    expect(COGPIT_BROWSER_SKILL).toContain('curl -s "$BASE/api/browser"')
    expect(COGPIT_BROWSER_SKILL).toContain("PATCH")
  })

  it("tells the agent to name the browser and to hand logins to the user", () => {
    expect(COGPIT_BROWSER_SKILL).toContain("open the Browser panel to watch")
    expect(COGPIT_BROWSER_SKILL).toMatch(/log in inside the Browser panel/)
  })
})

describe("ensurePlugin", () => {
  it("writes the manifest and the skill, and returns the plugin dir", () => {
    expect(ensurePlugin()).toBe(pluginDir())
    expect(pluginManifestFile()).toBe(join(pluginDir(), ".claude-plugin", "plugin.json"))
    expect(pluginSkillFile()).toBe(join(pluginDir(), "skills", SKILL_NAME, "SKILL.md"))
    expect(JSON.parse(readFileSync(pluginManifestFile(), "utf8"))).toEqual(PLUGIN_MANIFEST)
    expect(readFileSync(pluginSkillFile(), "utf8")).toBe(COGPIT_BROWSER_SKILL)
  })

  it("leaves unchanged files alone on a second call", () => {
    ensurePlugin()
    utimesSync(pluginManifestFile(), AGE, AGE)
    utimesSync(pluginSkillFile(), AGE, AGE)
    const before = [pluginManifestFile(), pluginSkillFile()].map((path) => statSync(path).mtimeMs)
    ensurePlugin()
    expect([pluginManifestFile(), pluginSkillFile()].map((path) => statSync(path).mtimeMs)).toEqual(before)
  })

  it("rewrites a file whose content drifted", () => {
    ensurePlugin()
    writeFileSync(pluginSkillFile(), "stale")
    ensurePlugin()
    expect(readFileSync(pluginSkillFile(), "utf8")).toBe(COGPIT_BROWSER_SKILL)
  })
})

describe("installSkill", () => {
  it("installs into the config root of each target", () => {
    expect(installSkill("claude")).toBe(join(root, "home", ".claude", "skills", SKILL_NAME))
    expect(installSkill("codex")).toBe(join(root, "home", ".codex", "skills", SKILL_NAME))
    for (const dir of [".claude", ".codex"]) {
      expect(readFileSync(join(root, "home", dir, "skills", SKILL_NAME, "SKILL.md"), "utf8"))
        .toBe(COGPIT_BROWSER_SKILL)
    }
  })

  it("overwrites an older copy", () => {
    const dir = installSkill("claude")
    writeFileSync(join(dir, "SKILL.md"), "stale")
    installSkill("claude")
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe(COGPIT_BROWSER_SKILL)
  })

  it("falls back to the real home when no override is set", () => {
    delete process.env.COGPIT_SKILL_HOME
    const home = join(root, "fallback")
    mkdirSync(home)
    const previous = process.env.HOME
    process.env.HOME = home
    try {
      const dir = installSkill("claude")
      expect(dir.startsWith(home)).toBe(true)
      expect(existsSync(join(dir, "SKILL.md"))).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.HOME
      else process.env.HOME = previous
    }
  })
})

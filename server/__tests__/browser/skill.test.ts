// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { pluginDir } from "../../browser/paths"
import {
  COGPIT_BROWSER_SKILL,
  ensurePlugin,
  installSkill,
  installSkillEverywhere,
  PLUGIN_MANIFEST,
  pluginManifestFile,
  pluginSkillFile,
  SKILL_NAME,
  skillTargets,
} from "../../browser/skill"
import { AGENT_KINDS, descriptorFor } from "../../../shared/session/agent-descriptors"

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

/** Non-null unless no CLI takes a plugin at all, which the descriptor table rules out. */
function manifestFile(): string {
  const path = pluginManifestFile()
  if (path === null) throw new Error("No agent CLI takes a plugin")
  return path
}

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

  it("explains redirection and the limits of hook coverage", () => {
    expect(COGPIT_BROWSER_SKILL).toContain("In SDK sessions Cogpit redirects recognized subagent browser calls")
    expect(COGPIT_BROWSER_SKILL).toContain("outside this hook's coverage")
    expect(COGPIT_BROWSER_SKILL).toMatch(/rewritten onto a `tmp-` browser before/)
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

  it("warns that the panel drives the page viewport", () => {
    expect(COGPIT_BROWSER_SKILL).toContain("Opening or resizing the Browser panel sets the page's viewport")
    expect(COGPIT_BROWSER_SKILL).toContain("agent-browser set viewport <w> <h>")
  })

  it("tells the agent to name the browser and to hand logins to the user", () => {
    expect(COGPIT_BROWSER_SKILL).toContain("open the Browser panel to watch")
    expect(COGPIT_BROWSER_SKILL).toMatch(/log in inside the Browser panel/)
  })
})

describe("ensurePlugin", () => {
  it("writes the manifest and the skill, and returns the plugin dir", () => {
    expect(ensurePlugin()).toBe(pluginDir())
    expect(manifestFile()).toBe(join(pluginDir(), ".claude-plugin", "plugin.json"))
    expect(pluginSkillFile()).toBe(join(pluginDir(), "skills", SKILL_NAME, "SKILL.md"))
    expect(JSON.parse(readFileSync(manifestFile(), "utf8"))).toEqual(PLUGIN_MANIFEST)
    expect(readFileSync(pluginSkillFile(), "utf8")).toBe(COGPIT_BROWSER_SKILL)
  })

  it("leaves unchanged files alone on a second call", () => {
    ensurePlugin()
    utimesSync(manifestFile(), AGE, AGE)
    utimesSync(pluginSkillFile(), AGE, AGE)
    const before = [manifestFile(), pluginSkillFile()].map((path) => statSync(path).mtimeMs)
    ensurePlugin()
    expect([manifestFile(), pluginSkillFile()].map((path) => statSync(path).mtimeMs)).toEqual(before)
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
    const homeKey = process.platform === "win32" ? "USERPROFILE" : "HOME"
    const previous = process.env[homeKey]
    process.env[homeKey] = home
    try {
      const dir = installSkill("claude")
      expect(dir.startsWith(home)).toBe(true)
      expect(existsSync(join(dir, "SKILL.md"))).toBe(true)
    } finally {
      if (previous === undefined) delete process.env[homeKey]
      else process.env[homeKey] = previous
    }
  })
})

describe("skillTargets", () => {
  const kindsWithSkills = AGENT_KINDS.filter((kind) => descriptorFor(kind).config.skillsDir !== null)

  it("lists every CLI that reads skills, with the config root an install writes into", () => {
    const targets = skillTargets()

    expect(targets.map((target) => target.kind)).toEqual(kindsWithSkills)
    expect(targets.length).toBeGreaterThan(1)
    for (const target of targets) {
      const descriptor = descriptorFor(target.kind)
      expect(target.label).toBe(descriptor.displayName)
      expect(target.configRoot).toBe(join(root, "home", descriptor.config.rootDirName))
      expect(target.installed).toBe(false)
    }
  })

  it("calls a target installed only while its file matches the current skill", () => {
    const [first] = skillTargets()
    const dir = installSkill(first.kind)

    expect(skillTargets()[0].installed).toBe(true)

    writeFileSync(join(dir, "SKILL.md"), "an older skill")
    expect(skillTargets()[0].installed).toBe(false)
  })

  it("marks the CLIs the plugin Cogpit writes already reaches", () => {
    const manifest = manifestFile()

    for (const target of skillTargets()) {
      const { pluginManifestDir } = descriptorFor(target.kind).config
      expect(target.automatic).toBe(
        pluginManifestDir !== null && manifest.startsWith(join(pluginDir(), pluginManifestDir)),
      )
    }
    expect(skillTargets().some((target) => target.automatic)).toBe(true)
  })
})

describe("installSkillEverywhere", () => {
  interface Target {
    /** The CLI's global config root, e.g. `<home>/.claude`. */
    configRoot: string
    dir: string
    skill: string
  }

  function targets(): Target[] {
    return AGENT_KINDS.flatMap((kind) => {
      const { rootDirName, skillsDir } = descriptorFor(kind).config
      if (skillsDir === null) return []
      const configRoot = join(root, "home", rootDirName)
      const dir = join(configRoot, skillsDir, SKILL_NAME)
      return [{ configRoot, dir, skill: join(dir, "SKILL.md") }]
    })
  }

  it("writes into every config root that exists", () => {
    for (const target of targets()) mkdirSync(target.configRoot, { recursive: true })

    expect(installSkillEverywhere()).toEqual(targets().map((target) => target.dir))
    for (const target of targets()) {
      expect(readFileSync(target.skill, "utf8")).toBe(COGPIT_BROWSER_SKILL)
    }
  })

  it("skips a CLI whose config root the user does not have", () => {
    const [first, ...rest] = targets()
    mkdirSync(first.configRoot, { recursive: true })

    expect(installSkillEverywhere()).toEqual([first.dir])
    for (const target of rest) expect(existsSync(target.configRoot)).toBe(false)
  })

  it("installs the rest and reports when one CLI cannot be written", () => {
    const [blocked, ...rest] = targets()
    expect(rest.length).toBeGreaterThan(0)
    for (const target of targets()) mkdirSync(target.configRoot, { recursive: true })
    // A file where the skill directory has to go, so only this write throws.
    mkdirSync(dirname(blocked.dir), { recursive: true })
    writeFileSync(blocked.dir, "not a directory")

    expect(() => installSkillEverywhere()).toThrow(/did not reach/)
    for (const target of rest) expect(readFileSync(target.skill, "utf8")).toBe(COGPIT_BROWSER_SKILL)
  })

  it("leaves an unchanged file alone on a second run", () => {
    for (const target of targets()) mkdirSync(target.configRoot, { recursive: true })
    installSkillEverywhere()
    for (const target of targets()) utimesSync(target.skill, AGE, AGE)
    const before = targets().map((target) => statSync(target.skill).mtimeMs)

    installSkillEverywhere()

    expect(targets().map((target) => statSync(target.skill).mtimeMs)).toEqual(before)
  })
})

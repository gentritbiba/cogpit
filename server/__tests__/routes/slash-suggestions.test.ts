// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { join } from "node:path"
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

// The factory only reads `fakeHome` when homedir() is called, which is after this module evaluates.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => fakeHome,
}))

/** Home directory the route scans; the plugin and user fixtures are built underneath it. */
const fakeHome = join(tmpdir(), "slash-suggestions-home")

import type { Middleware } from "../../helpers"
import { asIncomingMessage, asServerResponse, getRouteHandler } from "../http-fixtures"
import type { SlashSuggestion } from "../../routes/slash-suggestions"
import {
  BUILTIN_SKILLS,
  parseFrontmatter,
  expandCommand,
  isAllowedCommandPath,
  registerSlashSuggestionRoutes,
} from "../../routes/slash-suggestions"

describe("parseFrontmatter", () => {
  it("parses simple frontmatter with description", () => {
    const content = `---\ndescription: Commit all changes\n---\n\nBody text`
    const result = parseFrontmatter(content)
    expect(result).toEqual({ description: "Commit all changes" })
  })

  it("parses multiple frontmatter fields", () => {
    const content = `---\nname: my-skill\ndescription: A useful skill\nlicense: MIT\n---\n\nBody`
    const result = parseFrontmatter(content)
    expect(result).toEqual({ name: "my-skill", description: "A useful skill", license: "MIT" })
  })

  it("strips surrounding quotes from values", () => {
    const content = `---\ndescription: "Quoted value"\nname: 'single quoted'\n---\n`
    const result = parseFrontmatter(content)
    expect(result.description).toBe("Quoted value")
    expect(result.name).toBe("single quoted")
  })

  it("returns empty object when no frontmatter", () => {
    const content = "Just some markdown text"
    expect(parseFrontmatter(content)).toEqual({})
  })

  it("returns empty object for empty content", () => {
    expect(parseFrontmatter("")).toEqual({})
  })

  it("handles frontmatter with colons in values", () => {
    const content = `---\ndescription: Use when: things break\n---\n`
    const result = parseFrontmatter(content)
    expect(result.description).toBe("Use when: things break")
  })

  it("skips lines without colons", () => {
    const content = `---\ndescription: Valid\njust-text\n---\n`
    const result = parseFrontmatter(content)
    expect(result).toEqual({ description: "Valid" })
  })

  it("handles Windows-style line endings", () => {
    const content = "---\r\ndescription: Windows\r\n---\r\nBody"
    const result = parseFrontmatter(content)
    expect(result).toEqual({ description: "Windows" })
  })
})

describe("isAllowedCommandPath", () => {
  it("allows valid .claude/commands/ path", () => {
    expect(isAllowedCommandPath("/Users/user/.claude/commands/commit.md")).toBe(true)
  })

  it("allows valid project .claude/commands/ path", () => {
    expect(isAllowedCommandPath("/home/user/project/.claude/commands/fix.md")).toBe(true)
  })

  it("allows plugin skill paths inside .claude/", () => {
    expect(isAllowedCommandPath("/Users/user/.claude/plugins/cache/skills/SKILL.md")).toBe(true)
  })

  it("rejects paths not inside .claude directory", () => {
    expect(isAllowedCommandPath("/Users/user/commands/commit.md")).toBe(false)
  })

  it("rejects non-.md files", () => {
    expect(isAllowedCommandPath("/Users/user/.claude/commands/evil.sh")).toBe(false)
  })

  it("rejects .claude-evil directory (substring attack)", () => {
    // ".claude-evil" contains ".claude" as a prefix but not as a directory segment
    expect(isAllowedCommandPath("/Users/user/.claude-evil/commands/commit.md")).toBe(false)
  })

  it("rejects path traversal attempts", () => {
    expect(isAllowedCommandPath("/Users/user/.claude/../../../etc/passwd.md")).toBe(false)
  })

  it("rejects .md file that is not inside a .claude directory", () => {
    expect(isAllowedCommandPath("/tmp/random-file.md")).toBe(false)
  })

  it("rejects empty path", () => {
    expect(isAllowedCommandPath("")).toBe(false)
  })
})

describe("expandCommand", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "slash-test-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("strips frontmatter and returns body", async () => {
    const filePath = join(tmpDir, "test.md")
    await writeFile(filePath, `---\ndescription: Test command\n---\n\nDo the thing\nSecond line`)
    const result = await expandCommand(filePath, "")
    expect(result).toBe("Do the thing\nSecond line")
  })

  it("replaces $ARGUMENTS with provided args", async () => {
    const filePath = join(tmpDir, "test.md")
    await writeFile(filePath, `---\ndescription: Test\n---\n\nRun this with $ARGUMENTS please`)
    const result = await expandCommand(filePath, "my-args here")
    expect(result).toBe("Run this with my-args here please")
  })

  it("replaces multiple $ARGUMENTS occurrences", async () => {
    const filePath = join(tmpDir, "test.md")
    await writeFile(filePath, `---\ndescription: Test\n---\n\n$ARGUMENTS first, then $ARGUMENTS again`)
    const result = await expandCommand(filePath, "foo")
    expect(result).toBe("foo first, then foo again")
  })

  it("returns content as-is when no frontmatter", async () => {
    const filePath = join(tmpDir, "test.md")
    await writeFile(filePath, "Just plain text\nWith lines")
    const result = await expandCommand(filePath, "")
    expect(result).toBe("Just plain text\nWith lines")
  })

  it("returns null for non-existent file", async () => {
    const result = await expandCommand(join(tmpDir, "nope.md"), "")
    expect(result).toBeNull()
  })

  it("trims whitespace from result", async () => {
    const filePath = join(tmpDir, "test.md")
    await writeFile(filePath, `---\ndescription: X\n---\n\n  Trimmed  \n\n`)
    const result = await expandCommand(filePath, "")
    expect(result).toBe("Trimmed")
  })
})

describe("BUILTIN_SKILLS", () => {
  it("gives every entry a name, a description, and a valid type", () => {
    expect(BUILTIN_SKILLS.length).toBeGreaterThan(0)
    for (const entry of BUILTIN_SKILLS) {
      expect(entry.name, JSON.stringify(entry)).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(entry.description.length, entry.name).toBeGreaterThan(0)
      expect(["command", "skill"], entry.name).toContain(entry.type)
      expect(entry.source, entry.name).toBe("built-in")
    }
  })

  it("has no duplicate names", () => {
    const names = BUILTIN_SKILLS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it("keeps the stable, high-traffic entries", () => {
    const names = BUILTIN_SKILLS.map((s) => s.name)
    expect(names).toContain("simplify")
    expect(names).toContain("compact")
  })

  it("leaves out commands whose UX is bound to the terminal", () => {
    const names = BUILTIN_SKILLS.map((s) => s.name)
    expect(names).not.toContain("doctor")
    expect(names).not.toContain("color")
  })
})

describe("GET /api/slash-suggestions", () => {
  let handlers: Map<string, Middleware>

  const call = async (cwd = "") => {
    const handler = getRouteHandler(handlers, "/api/slash-suggestions")
    let payload = ""
    const req = asIncomingMessage({
      method: "GET",
      url: `/api/slash-suggestions?cwd=${encodeURIComponent(cwd)}`,
      headers: {},
    })
    const res = asServerResponse({
      setHeader: () => {},
      end: (data?: string) => { payload = data || "" },
    })
    await handler(req, res, () => {})
    return JSON.parse(payload).suggestions as SlashSuggestion[]
  }

  beforeEach(async () => {
    await rm(fakeHome, { recursive: true, force: true })
    handlers = new Map()
    registerSlashSuggestionRoutes((path: string, handler: Middleware) => {
      handlers.set(path, handler)
    })
  })

  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true })
  })

  const writeSkill = async (dir: string, name: string, description: string) => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody`)
  }

  const installPlugin = async (pluginKey: string) => {
    const installPath = join(fakeHome, "plugin-installs", pluginKey)
    await mkdir(join(fakeHome, ".claude", "plugins"), { recursive: true })
    await writeFile(
      join(fakeHome, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { [pluginKey]: [{ installPath }] } }),
    )
    return installPath
  }

  it("namespaces a plugin skill by its plugin", async () => {
    const installPath = await installPlugin("superpowers@superpowers-dev")
    await writeSkill(join(installPath, "skills", "brainstorming"), "brainstorming", "Refine ideas")

    const suggestions = await call()
    const skill = suggestions.find((s) => s.name.endsWith("brainstorming"))
    expect(skill?.name).toBe("superpowers:brainstorming")
  })

  it("namespaces a plugin skill by directory when frontmatter has no name", async () => {
    const installPath = await installPlugin("superpowers@superpowers-dev")
    await mkdir(join(installPath, "skills", "unnamed"), { recursive: true })
    await writeFile(
      join(installPath, "skills", "unnamed", "SKILL.md"),
      `---\ndescription: No name field\n---\n\nBody`,
    )

    const suggestions = await call()
    expect(suggestions.map((s) => s.name)).toContain("superpowers:unnamed")
  })

  it("namespaces plugin skills and plugin commands the same way", async () => {
    const installPath = await installPlugin("superpowers@superpowers-dev")
    await writeSkill(join(installPath, "skills", "shared"), "shared", "A skill")
    await mkdir(join(installPath, "commands"), { recursive: true })
    await writeFile(join(installPath, "commands", "shared.md"), `---\ndescription: A command\n---\n\nBody`)

    const suggestions = await call()
    const names = suggestions.filter((s) => s.name.endsWith("shared")).map((s) => s.name)
    expect(names).toEqual(["superpowers:shared", "superpowers:shared"])
  })

  it("keeps a same-named skill from two plugins distinguishable", async () => {
    const aPath = join(fakeHome, "plugin-installs", "alpha")
    const bPath = join(fakeHome, "plugin-installs", "beta")
    await mkdir(join(fakeHome, ".claude", "plugins"), { recursive: true })
    await writeFile(
      join(fakeHome, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: {
          "alpha@vendor": [{ installPath: aPath }],
          "beta@vendor": [{ installPath: bPath }],
        },
      }),
    )
    await writeSkill(join(aPath, "skills", "review"), "review", "Alpha review")
    await writeSkill(join(bPath, "skills", "review"), "review", "Beta review")

    const suggestions = await call()
    const names = suggestions.map((s) => s.name)
    expect(names).toContain("alpha:review")
    expect(names).toContain("beta:review")
  })

  it("leaves a user skill unqualified", async () => {
    await writeSkill(join(fakeHome, ".claude", "skills", "qa"), "qa", "Test the change")

    const suggestions = await call()
    const skill = suggestions.find((s) => s.name === "qa")
    expect(skill).toBeDefined()
    expect(skill?.source).toBe("user")
  })
})

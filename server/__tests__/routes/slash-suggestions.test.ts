// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { join } from "node:path"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import { parseFrontmatter, expandCommand, isAllowedCommandPath } from "../../routes/slash-suggestions"

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

// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { join } from "node:path"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { globalLayout, projectLayout, mergeCliItems } from "../../../routes/config-browser/configSources"
import type { ConfigTreeItem } from "../../../routes/config-browser/configTree"

function file(name: string, path: string, extra: Partial<ConfigTreeItem> = {}): ConfigTreeItem {
  return { name, path, type: "file", fileType: "skill", ...extra }
}

describe("config layouts", () => {
  it("covers Claude, Codex, and the shared source for skills", () => {
    const layout = globalLayout()
    const skillDirs = layout.skills.map((source) => source.dir)

    expect(skillDirs.some((dir) => dir.endsWith(join(".claude", "skills")))).toBe(true)
    expect(skillDirs.some((dir) => dir.endsWith(join(".codex", "skills")))).toBe(true)
    expect(skillDirs.some((dir) => dir.endsWith(join(".agents", "skills")))).toBe(true)
    // The shared directory is a source of truth, not something a CLI loads.
    expect(layout.skills.find((source) => source.dir.includes(".agents"))?.cli).toEqual([])
  })

  it("covers both instruction files and both settings files per scope", () => {
    const project = projectLayout("/tmp/demo")

    expect(project.instructions.map((source) => source.name)).toEqual([
      "CLAUDE.md",
      ".claude/CLAUDE.md",
      "AGENTS.md",
    ])
    expect(project.settings.map((source) => source.name)).toEqual([
      "settings.local.json",
      "config.toml",
    ])
    expect(project.agents.map((source) => source.cli)).toEqual([["claude"], ["codex"]])
  })
})

describe("mergeCliItems", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "configSources-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("collapses entries that resolve to the same file and unions their CLIs", async () => {
    const shared = join(tmpDir, "shared", "commit")
    await mkdir(shared, { recursive: true })
    await writeFile(join(shared, "SKILL.md"), "shared", "utf-8")

    const claudeLink = join(tmpDir, "claude-commit")
    const codexLink = join(tmpDir, "codex-commit")
    await symlink(shared, claudeLink, process.platform === "win32" ? "junction" : undefined)
    await symlink(shared, codexLink, process.platform === "win32" ? "junction" : undefined)

    const merged = await mergeCliItems([
      [file("commit", join(claudeLink, "SKILL.md"), { cli: ["claude"], description: "Commit" })],
      [file("commit", join(codexLink, "SKILL.md"), { cli: ["codex"] })],
      [file("commit", join(shared, "SKILL.md"), { cli: [] })],
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0].cli).toEqual(["claude", "codex"])
    // The first group supplies the representative entry.
    expect(merged[0].path).toBe(join(claudeLink, "SKILL.md"))
    expect(merged[0].description).toBe("Commit")
  })

  it("keeps same-named copies that are genuinely different files apart", async () => {
    const claudeSkill = join(tmpDir, "claude", "docs")
    const codexSkill = join(tmpDir, "codex", "docs")
    await mkdir(claudeSkill, { recursive: true })
    await mkdir(codexSkill, { recursive: true })
    await writeFile(join(claudeSkill, "SKILL.md"), "a", "utf-8")
    await writeFile(join(codexSkill, "SKILL.md"), "b", "utf-8")

    const merged = await mergeCliItems([
      [file("docs", join(claudeSkill, "SKILL.md"), { cli: ["claude"] })],
      [file("docs", join(codexSkill, "SKILL.md"), { cli: ["codex"] })],
    ])

    expect(merged).toHaveLength(2)
    expect(merged.map((item) => item.cli)).toEqual([["claude"], ["codex"]])
  })

  it("reports an entry only present in the shared source as loaded by no CLI", async () => {
    const orphan = join(tmpDir, "shared", "orphan")
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, "SKILL.md"), "orphan", "utf-8")

    const merged = await mergeCliItems([
      [],
      [],
      [file("orphan", join(orphan, "SKILL.md"), { cli: [] })],
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0].cli).toEqual([])
  })

  it("merges the children of directories that appear in several roots", async () => {
    const merged = await mergeCliItems([
      [{
        name: "nested",
        path: join(tmpDir, "nested"),
        type: "directory",
        cli: ["claude"],
        children: [file("a", join(tmpDir, "nested", "a", "SKILL.md"), { cli: ["claude"] })],
      }],
      [{
        name: "nested",
        path: join(tmpDir, "nested"),
        type: "directory",
        cli: ["codex"],
        children: [file("b", join(tmpDir, "nested", "b", "SKILL.md"), { cli: ["codex"] })],
      }],
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0].cli).toEqual(["claude", "codex"])
    expect(merged[0].children?.map((child) => child.name)).toEqual(["a", "b"])
  })
})

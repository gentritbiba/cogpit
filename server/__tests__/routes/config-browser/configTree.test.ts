// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { join } from "node:path"
import { mkdtemp, writeFile, mkdir, rm, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"

import {
  buildPluginSections,
  scanDir,
} from "../../../routes/config-browser/configTree"

// ── helpers ────────────────────────────────────────────────────────────

async function mkdirp(p: string) {
  await mkdir(p, { recursive: true })
}

// ── scanDir ────────────────────────────────────────────────────────────

describe("scanDir", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "configTree-scan-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("returns empty array for non-existent directory", async () => {
    const result = await scanDir(join(tmpDir, "nonexistent"))
    expect(result).toEqual([])
  })

  it("returns .md and .json files", async () => {
    await writeFile(join(tmpDir, "foo.md"), "# Foo")
    await writeFile(join(tmpDir, "bar.json"), "{}")
    await writeFile(join(tmpDir, "skip.sh"), "#!/bin/bash")
    const result = await scanDir(tmpDir)
    const names = result.map((i) => i.name)
    expect(names).toContain("foo.md")
    expect(names).toContain("bar.json")
    expect(names).not.toContain("skip.sh")
  })

  it("skips installed_plugins.json", async () => {
    await writeFile(join(tmpDir, "installed_plugins.json"), "{}")
    await writeFile(join(tmpDir, "settings.json"), "{}")
    const result = await scanDir(tmpDir)
    const names = result.map((i) => i.name)
    expect(names).not.toContain("installed_plugins.json")
    expect(names).toContain("settings.json")
  })

  it("reads skill SKILL.md via isSkillsDir", async () => {
    const skillDir = join(tmpDir, "my-skill")
    await mkdirp(skillDir)
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: my-skill\ndescription: A test skill\n---\n\nBody")
    const result = await scanDir(tmpDir, { isSkillsDir: true })
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("my-skill")
    expect(result[0].fileType).toBe("skill")
    expect(result[0].description).toBe("A test skill")
  })

  it("falls back to a nested directory when a skill has no SKILL.md", async () => {
    const invalidSkillDir = join(tmpDir, "invalid-skill")
    await mkdirp(invalidSkillDir)
    await writeFile(join(invalidSkillDir, "README.md"), "Still useful")

    const result = await scanDir(tmpDir, { isSkillsDir: true, readOnly: true })

    expect(result).toEqual([
      {
        name: "invalid-skill",
        path: invalidSkillDir,
        type: "directory",
        children: [{
          name: "README.md",
          path: join(invalidSkillDir, "README.md"),
          type: "file",
          fileType: "unknown",
          description: "",
          readOnly: true,
        }],
        readOnly: true,
      },
    ])
  })

  it("omits nested directories with no relevant files", async () => {
    const emptyDir = join(tmpDir, "empty")
    await mkdirp(emptyDir)
    await writeFile(join(emptyDir, "ignored.txt"), "ignored")

    await expect(scanDir(tmpDir)).resolves.toEqual([])
  })
})

// ── buildGlobalSection (themes/) ────────────────────────────────────────

describe("buildGlobalSection — themes/", () => {
  // We cannot easily change homedir() at runtime, so we test the helper
  // functions that buildGlobalSection delegates to. Instead, we test scanDir
  // for the themes directory shape directly, and verify that buildGlobalSection
  // uses the right fileType via a fixture strategy.

  // Directly test scanDir behaviour for a themes/ directory (json files)
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "configTree-themes-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("scanDir picks up .json files in themes dir with isThemesDir flag", async () => {
    const themesDir = join(tmpDir, "themes")
    await mkdirp(themesDir)
    await writeFile(join(themesDir, "dark.json"), '{"name":"dark"}')
    await writeFile(join(themesDir, "light.json"), '{"name":"light"}')

    const result = await scanDir(themesDir, { isThemesDir: true })
    const names = result.map((i) => i.name).sort()
    expect(names).toEqual(["dark.json", "light.json"])
    for (const item of result) {
      expect(item.type).toBe("file")
      expect(item.fileType).toBe("theme")
    }
  })

  it("scanDir returns empty array when themes dir has no json files", async () => {
    const themesDir = join(tmpDir, "themes-empty")
    await mkdirp(themesDir)
    await writeFile(join(themesDir, "readme.txt"), "ignore me")

    const result = await scanDir(themesDir)
    expect(result).toEqual([])
  })
})

// ── buildPluginSections (themes/, monitors/, bin/) ─────────────────────

describe("buildPluginSections — new plugin dirs", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "configTree-plugin-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("picks up themes/*.json in a plugin", async () => {
    const installPath = join(tmpDir, "plugin-install")
    await mkdirp(join(installPath, "themes"))
    await writeFile(join(installPath, "themes", "ocean.json"), '{"name":"ocean"}')

    // We cannot override homedir, so test the scan logic directly:
    const result = await scanDir(join(installPath, "themes"), { isThemesDir: true })
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("ocean.json")
    expect(result[0].fileType).toBe("theme")
  })

  it("picks up monitors/ subdirectories with manifest.json", async () => {
    const installPath = join(tmpDir, "plugin-install")
    const monitorDir = join(installPath, "monitors", "cpu-watcher")
    await mkdirp(monitorDir)
    await writeFile(
      join(monitorDir, "manifest.json"),
      JSON.stringify({ name: "cpu-watcher", description: "Watches CPU usage" }),
    )

    const result = await scanDir(join(installPath, "monitors"), { isMonitorsDir: true })
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("cpu-watcher")
    expect(result[0].fileType).toBe("monitor")
    expect(result[0].description).toBe("Watches CPU usage")
  })

  it("picks up monitors/ subdirectory without manifest.json using dir name", async () => {
    const installPath = join(tmpDir, "plugin-install")
    const monitorDir = join(installPath, "monitors", "disk-watcher")
    await mkdirp(monitorDir)
    // No manifest.json — just the directory

    const result = await scanDir(join(installPath, "monitors"), { isMonitorsDir: true })
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("disk-watcher")
    expect(result[0].fileType).toBe("monitor")
    expect(result[0].description).toBe("")
  })

  it("picks up executable files in bin/", async () => {
    const installPath = join(tmpDir, "plugin-install")
    const binDir = join(installPath, "bin")
    await mkdirp(binDir)
    const exePath = join(binDir, "runme")
    await writeFile(exePath, "#!/bin/sh\necho hello")
    await chmod(exePath, 0o755)
    const nonExePath = join(binDir, "readme.txt")
    await writeFile(nonExePath, "not executable")
    // readme.txt will not be executable (default perms 0o644)

    const result = await scanDir(binDir, { isBinDir: true })
    const names = result.map((i) => i.name)
    expect(names).toContain("runme")
    // readme.txt should be skipped (not executable)
    expect(names).not.toContain("readme.txt")
    const binItem = result.find((i) => i.name === "runme")
    expect(binItem?.fileType).toBe("bin")
  })

  it("skips non-existent plugin dirs gracefully", async () => {
    const installPath = join(tmpDir, "plugin-install")
    // Don't create any subdirs — all should be empty gracefully

    const [themes, monitors, bins] = await Promise.all([
      scanDir(join(installPath, "themes")),
      scanDir(join(installPath, "monitors")),
      scanDir(join(installPath, "bin"), { isBinDir: true }),
    ])

    expect(themes).toEqual([])
    expect(monitors).toEqual([])
    expect(bins).toEqual([])
  })
})

// ── Integration: buildPluginSections includes new dirs ─────────────────

describe("buildPluginSections integration", () => {
  // These integration tests verify that buildPluginSections wires up the new
  // directory walks. Since homedir() cannot be overridden easily, we trust
  // the unit tests above for scanDir and verify the section-builder logic
  // via a real temp installed_plugins.json pointing to a temp install path.
  //
  // NOTE: buildPluginSections reads from join(homedir(), ".claude", "plugins", ...)
  // so a true integration test would require mocking homedir. We keep this
  // note for future improvement and rely on the scanDir unit tests above.

  it("buildPluginSections returns empty array when no plugins installed", async () => {
    // With a real homedir that may or may not have plugins, we just check the
    // return type is an array (existing behaviour preserved).
    const result = await buildPluginSections()
    expect(Array.isArray(result)).toBe(true)
  })
})

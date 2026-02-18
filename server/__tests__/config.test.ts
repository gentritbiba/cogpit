// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Stats, Dirent } from "node:fs"

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
}))

import { readFile, writeFile, stat, readdir } from "node:fs/promises"
import { resolve, join } from "node:path"

const mockedReadFile = vi.mocked(readFile)
const mockedWriteFile = vi.mocked(writeFile)
const mockedStat = vi.mocked(stat)
const mockedReaddir = vi.mocked(readdir)

// ── getDirs ─────────────────────────────────────────────────────────────

describe("getDirs", () => {
  it("constructs correct directory paths", async () => {
    const { getDirs } = await import("../config")
    const dirs = getDirs("/home/user/.claude")
    expect(dirs.PROJECTS_DIR).toBe(join("/home/user/.claude", "projects"))
    expect(dirs.TEAMS_DIR).toBe(join("/home/user/.claude", "teams"))
    expect(dirs.TASKS_DIR).toBe(join("/home/user/.claude", "tasks"))
    // UNDO_DIR is relative to PROJECT_ROOT, not claudeDir
    expect(dirs.UNDO_DIR).toContain("undo-history")
  })
})

// ── validateClaudeDir ───────────────────────────────────────────────────

describe("validateClaudeDir", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns valid for a directory with projects subdir", async () => {
    const { validateClaudeDir } = await import("../config")
    mockedStat.mockResolvedValueOnce({ isDirectory: () => true } as unknown as Stats)
    mockedReaddir.mockResolvedValueOnce(["projects", "other"] as unknown as Dirent[])

    const result = await validateClaudeDir("/some/dir")
    expect(result.valid).toBe(true)
    expect(result.resolved).toBe(resolve("/some/dir"))
  })

  it("returns error when path is not a directory", async () => {
    const { validateClaudeDir } = await import("../config")
    mockedStat.mockResolvedValueOnce({ isDirectory: () => false } as unknown as Stats)

    const result = await validateClaudeDir("/some/file")
    expect(result.valid).toBe(false)
    expect(result.error).toContain("not a directory")
  })

  it("returns error when path does not exist", async () => {
    const { validateClaudeDir } = await import("../config")
    mockedStat.mockRejectedValueOnce(new Error("ENOENT"))

    const result = await validateClaudeDir("/nonexistent")
    expect(result.valid).toBe(false)
    expect(result.error).toContain("does not exist")
  })

  it("returns error when directory has no projects subdir", async () => {
    const { validateClaudeDir } = await import("../config")
    mockedStat.mockResolvedValueOnce({ isDirectory: () => true } as unknown as Stats)
    mockedReaddir.mockResolvedValueOnce(["other", "stuff"] as unknown as Dirent[])

    const result = await validateClaudeDir("/some/dir")
    expect(result.valid).toBe(false)
    expect(result.error).toContain("projects")
  })

  it("returns error when directory contents cannot be read", async () => {
    const { validateClaudeDir } = await import("../config")
    mockedStat.mockResolvedValueOnce({ isDirectory: () => true } as unknown as Stats)
    mockedReaddir.mockRejectedValueOnce(new Error("EPERM"))

    const result = await validateClaudeDir("/restricted/dir")
    expect(result.valid).toBe(false)
    expect(result.error).toContain("Cannot read directory")
  })
})

// ── loadConfig / saveConfig ─────────────────────────────────────────────

describe("loadConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("loads valid config", async () => {
    const { loadConfig } = await import("../config")
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({ claudeDir: "/home/.claude", networkAccess: true, networkPassword: "pass" })
    )

    const config = await loadConfig()
    expect(config).not.toBeNull()
    expect(config!.claudeDir).toBe("/home/.claude")
    expect(config!.networkAccess).toBe(true)
    expect(config!.networkPassword).toBe("pass")
  })

  it("returns null for missing file", async () => {
    const { loadConfig } = await import("../config")
    mockedReadFile.mockRejectedValueOnce(new Error("ENOENT"))

    const config = await loadConfig()
    expect(config).toBeNull()
  })

  it("returns null for malformed JSON", async () => {
    const { loadConfig } = await import("../config")
    mockedReadFile.mockResolvedValueOnce("not-json{{{")

    const config = await loadConfig()
    expect(config).toBeNull()
  })

  it("returns null when claudeDir is missing from JSON", async () => {
    const { loadConfig } = await import("../config")
    mockedReadFile.mockResolvedValueOnce(JSON.stringify({ otherKey: "value" }))

    const config = await loadConfig()
    expect(config).toBeNull()
  })
})

describe("saveConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("writes config as formatted JSON", async () => {
    const { saveConfig } = await import("../config")
    mockedWriteFile.mockResolvedValueOnce(undefined)

    const config = { claudeDir: "/home/.claude" }
    await saveConfig(config)

    expect(mockedWriteFile).toHaveBeenCalledOnce()
    const [, content, encoding] = mockedWriteFile.mock.calls[0]
    expect(encoding).toBe("utf-8")
    expect(JSON.parse(content as string)).toEqual(config)
  })
})

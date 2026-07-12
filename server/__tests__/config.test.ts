// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Stats, Dirent } from "node:fs"

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(),
}))

vi.mock("node:os", () => ({
  homedir: () => "/home/test",
}))

vi.mock("../password-utils", () => ({
  hashPassword: vi.fn(),
  isPasswordHashed: vi.fn(),
}))

import { readFile, writeFile, stat, readdir } from "node:fs/promises"
import { hashPassword, isPasswordHashed } from "../password-utils"
import { resolve, join } from "node:path"

const mockedReadFile = vi.mocked(readFile)
const mockedWriteFile = vi.mocked(writeFile)
const mockedStat = vi.mocked(stat)
const mockedReaddir = vi.mocked(readdir)
const mockedHashPassword = vi.mocked(hashPassword)
const mockedIsPasswordHashed = vi.mocked(isPasswordHashed)

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
    delete process.env.CODEX_HOME
  })

  it("loads valid config with already-hashed password (no migration)", async () => {
    const { loadConfig } = await import("../config")
    mockedIsPasswordHashed.mockReturnValueOnce(true)
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({ claudeDir: "/home/.claude", networkAccess: true, networkPassword: "$sha256$abc:def" })
    )

    const config = await loadConfig()
    expect(config).not.toBeNull()
    expect(config!.claudeDir).toBe("/home/.claude")
    expect(config!.networkAccess).toBe(true)
    expect(config!.networkPassword).toBe("$sha256$abc:def")
    // Should NOT have written back to disk
    expect(mockedWriteFile).not.toHaveBeenCalled()
  })

  it("migrates plaintext password to hashed on first read and writes back to disk", async () => {
    const { loadConfig } = await import("../config")
    mockedIsPasswordHashed.mockReturnValueOnce(false)
    mockedHashPassword.mockReturnValueOnce("$sha256$aabbcc:ddeeff")
    mockedWriteFile.mockResolvedValueOnce(undefined)
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({ claudeDir: "/home/.claude", networkAccess: true, networkPassword: "plaintextpassword" })
    )

    const config = await loadConfig()
    expect(config).not.toBeNull()
    // Returned config should have the hashed password
    expect(config!.networkPassword).toBe("$sha256$aabbcc:ddeeff")
    // hashPassword must have been called with the original plaintext
    expect(mockedHashPassword).toHaveBeenCalledWith("plaintextpassword")
    // Should have written the migrated config back to disk
    expect(mockedWriteFile).toHaveBeenCalledOnce()
    const writtenContent = JSON.parse((mockedWriteFile.mock.calls[0][1] as string))
    expect(writtenContent.networkPassword).toBe("$sha256$aabbcc:ddeeff")
  })

  it("does not mask a config migration failure as first-run Codex setup", async () => {
    const { loadConfig } = await import("../config")
    mockedIsPasswordHashed.mockReturnValueOnce(false)
    mockedHashPassword.mockReturnValueOnce("$sha256$aabbcc:ddeeff")
    mockedReadFile.mockResolvedValueOnce(JSON.stringify({
      claudeDir: "/home/.claude",
      networkPassword: "plaintextpassword",
    }))
    mockedWriteFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

    const config = await loadConfig()

    expect(config).toBeNull()
    expect(mockedStat).not.toHaveBeenCalled()
  })

  it("does not migrate when networkPassword is empty/missing", async () => {
    const { loadConfig } = await import("../config")
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({ claudeDir: "/home/.claude", networkAccess: false })
    )

    const config = await loadConfig()
    expect(config).not.toBeNull()
    expect(config!.networkPassword).toBeUndefined()
    expect(mockedHashPassword).not.toHaveBeenCalled()
    expect(mockedWriteFile).not.toHaveBeenCalled()
  })

  it("returns null for missing file", async () => {
    const { loadConfig } = await import("../config")
    mockedReadFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
    mockedStat.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

    const config = await loadConfig()
    expect(config).toBeNull()
  })

  it("bootstraps a Codex-only config when no config file exists", async () => {
    const { loadConfig } = await import("../config")
    mockedReadFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
    mockedStat.mockResolvedValueOnce({ isDirectory: () => true } as unknown as Stats)

    const config = await loadConfig()

    expect(config).toEqual({
      claudeDir: "/home/test/.claude",
      codexOnly: true,
    })
    expect(mockedStat).toHaveBeenCalledWith(resolve("/home/test/.codex"))
    expect(mockedWriteFile).not.toHaveBeenCalled()
  })

  it("honors CODEX_HOME when bootstrapping a Codex-only config", async () => {
    const { loadConfig } = await import("../config")
    process.env.CODEX_HOME = "/opt/codex-data"
    mockedReadFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
    mockedStat.mockResolvedValueOnce({ isDirectory: () => true } as unknown as Stats)

    const config = await loadConfig()

    expect(config?.codexOnly).toBe(true)
    expect(mockedStat).toHaveBeenCalledWith(resolve("/opt/codex-data"))
  })

  it("returns null for malformed JSON", async () => {
    const { loadConfig } = await import("../config")
    mockedReadFile.mockResolvedValueOnce("not-json{{{")

    const config = await loadConfig()
    expect(config).toBeNull()
    expect(mockedStat).not.toHaveBeenCalled()
  })

  it("returns null when claudeDir is missing from JSON", async () => {
    const { loadConfig } = await import("../config")
    mockedReadFile.mockResolvedValueOnce(JSON.stringify({ otherKey: "value" }))

    const config = await loadConfig()
    expect(config).toBeNull()
  })

  it("restores a persisted Codex-only config", async () => {
    const { loadConfig } = await import("../config")
    mockedReadFile.mockResolvedValueOnce(JSON.stringify({
      claudeDir: "/home/test/.claude",
      codexOnly: true,
    }))

    const config = await loadConfig()

    expect(config?.codexOnly).toBe(true)
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

// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock node:os platform before importing
const mockPlatform = vi.fn(() => "darwin" as NodeJS.Platform)
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, platform: () => mockPlatform() }
})

// Mock config for resolveActionPath
const mockGetConfig = vi.fn()
vi.mock("../../config", () => ({
  getConfig: () => mockGetConfig(),
  getDirs: (claudeDir: string) => ({
    PROJECTS_DIR: claudeDir + "/projects",
    TEAMS_DIR: claudeDir + "/teams",
    TASKS_DIR: claudeDir + "/tasks",
    UNDO_DIR: "/undo",
  }),
}))

// Mock fs for resolveActionPath
const mockReaddir = vi.fn()
const mockOpen = vi.fn()
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    readdir: (...args: unknown[]) => mockReaddir(...args),
    open: (...args: unknown[]) => mockOpen(...args),
  }
})

import { terminalCommand, resolveActionPath } from "../../routes/editor"

describe("terminalCommand", () => {
  beforeEach(() => {
    mockPlatform.mockReturnValue("darwin")
  })

  describe("binary paths (containing /)", () => {
    it("uses --single-instance -d for kitty binary", () => {
      const result = terminalCommand("/usr/bin/kitty", "/tmp/project")
      expect(result).toEqual({ cmd: "/usr/bin/kitty", args: ["--single-instance", "-d", "/tmp/project"] })
    })

    it("uses --working-directory for ghostty binary", () => {
      const result = terminalCommand("/usr/bin/ghostty", "/tmp/project")
      expect(result).toEqual({ cmd: "/usr/bin/ghostty", args: ["--working-directory", "/tmp/project"] })
    })

    it("uses --working-directory for unknown binary", () => {
      const result = terminalCommand("/usr/local/bin/myterm", "/tmp/project")
      expect(result).toEqual({ cmd: "/usr/local/bin/myterm", args: ["--working-directory", "/tmp/project"] })
    })
  })

  describe("macOS app names", () => {
    it("uses open -a with --working-directory for Ghostty", () => {
      const result = terminalCommand("Ghostty", "/tmp/project")
      expect(result).toEqual({ cmd: "open", args: ["-a", "Ghostty", "--args", "--working-directory", "/tmp/project"] })
    })

    it("uses open -a with --working-directory for Alacritty", () => {
      const result = terminalCommand("Alacritty", "/tmp/project")
      expect(result).toEqual({ cmd: "open", args: ["-a", "Alacritty", "--args", "--working-directory", "/tmp/project"] })
    })

    it("uses open -a with --single-instance -d for kitty", () => {
      const result = terminalCommand("kitty", "/tmp/project")
      expect(result).toEqual({ cmd: "open", args: ["-a", "kitty", "--args", "--single-instance", "-d", "/tmp/project"] })
    })

    it("uses open -a with positional dir for Terminal.app", () => {
      const result = terminalCommand("Terminal", "/tmp/project")
      expect(result).toEqual({ cmd: "open", args: ["-a", "Terminal", "/tmp/project"] })
    })

    it("uses open -a with positional dir for iTerm", () => {
      const result = terminalCommand("iTerm", "/tmp/project")
      expect(result).toEqual({ cmd: "open", args: ["-a", "iTerm", "/tmp/project"] })
    })

    it("uses open -a with positional dir for Warp", () => {
      const result = terminalCommand("Warp", "/tmp/project")
      expect(result).toEqual({ cmd: "open", args: ["-a", "Warp", "/tmp/project"] })
    })
  })

  describe("Linux / Windows", () => {
    beforeEach(() => {
      mockPlatform.mockReturnValue("linux")
    })

    it("uses --single-instance -d for kitty", () => {
      const result = terminalCommand("kitty", "/tmp/project")
      expect(result).toEqual({ cmd: "kitty", args: ["--single-instance", "-d", "/tmp/project"] })
    })

    it("uses --working-directory for other terminals", () => {
      const result = terminalCommand("alacritty", "/tmp/project")
      expect(result).toEqual({ cmd: "alacritty", args: ["--working-directory", "/tmp/project"] })
    })
  })
})

describe("resolveActionPath", () => {
  beforeEach(() => {
    mockGetConfig.mockReset()
    mockReaddir.mockReset()
    mockOpen.mockReset()
  })

  it("returns path directly when provided", async () => {
    const result = await resolveActionPath({ path: "/Users/me/my-project" })
    expect(result).toBe("/Users/me/my-project")
  })

  it("prefers path over dirName when both provided", async () => {
    const result = await resolveActionPath({ path: "/Users/me/my-project", dirName: "-Users-me-my-project" })
    expect(result).toBe("/Users/me/my-project")
  })

  it("resolves cwd from session JSONL when only dirName is provided", async () => {
    mockGetConfig.mockReturnValue({ claudeDir: "/home/.claude" })
    mockReaddir.mockResolvedValue(["session1.jsonl"])
    const jsonLine = JSON.stringify({ cwd: "/Users/me/my-project", sessionId: "abc" })
    const mockFh = {
      read: vi.fn().mockImplementation((b: Buffer) => {
        Buffer.from(jsonLine).copy(b)
        return Promise.resolve({ bytesRead: jsonLine.length })
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }
    mockOpen.mockResolvedValue(mockFh)

    const result = await resolveActionPath({ dirName: "-Users-me-my-project" })
    expect(result).toBe("/Users/me/my-project")
  })

  it("falls back to lossy conversion when no JSONL files exist", async () => {
    mockGetConfig.mockReturnValue({ claudeDir: "/home/.claude" })
    mockReaddir.mockResolvedValue([])

    const result = await resolveActionPath({ dirName: "-Users-me-my-project" })
    expect(result).toBe("/Users/me/my/project")
  })

  it("returns null when neither path nor dirName provided", async () => {
    const result = await resolveActionPath({})
    expect(result).toBeNull()
  })

  it("returns null when dirName given but dirs not configured", async () => {
    mockGetConfig.mockReturnValue(null)
    const result = await resolveActionPath({ dirName: "-Users-me-my-project" })
    expect(result).toBeNull()
  })
})

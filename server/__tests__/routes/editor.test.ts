// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock node:os platform before importing
const mockPlatform = vi.fn(() => "darwin" as NodeJS.Platform)
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, platform: () => mockPlatform() }
})

import { terminalCommand } from "../../routes/editor"

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

// @vitest-environment node
import { describe, expect, it } from "vitest"
import { friendlySpawnError } from "../../agents/spawnError"

function errno(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}

describe("friendlySpawnError", () => {
  it("returns an install hint for ENOENT", () => {
    expect(friendlySpawnError(errno("spawn ENOENT", "ENOENT"))).toContain("not installed")
  })

  it("names the agent that failed to start", () => {
    expect(friendlySpawnError(errno("spawn ENOENT", "ENOENT"), "codex")).toContain("Codex")
    expect(friendlySpawnError(errno("spawn ENOENT", "ENOENT"), "copilot"))
      .toContain("GitHub Copilot CLI")
  })

  it("omits the install command for a CLI with no known one", () => {
    expect(friendlySpawnError(errno("spawn ENOENT", "ENOENT"), "codex"))
      .not.toContain("Install it with")
  })

  it("passes any other failure through untouched", () => {
    expect(friendlySpawnError(errno("something else", "EPERM"))).toBe("something else")
  })
})

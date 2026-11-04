// @vitest-environment node
import { describe, expect, it } from "vitest"
import { AGENT_NOT_INSTALLED, agentNotInstalledError, friendlySpawnError } from "../../agents/spawnError"
import { agentNotInstalledMessage } from "../../../shared/session/agentFailures"

function errno(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}

describe("friendlySpawnError", () => {
  it("says in plain words that the agent is missing, then how to get it on this machine", () => {
    expect(friendlySpawnError(errno("spawn ENOENT", "ENOENT"), "claude")).toBe(
      agentNotInstalledMessage("claude", process.platform),
    )
    expect(friendlySpawnError(errno("spawn ENOENT", "ENOENT"), "claude"))
      .toMatch(/^Claude Code isn't installed on this computer\.\nInstall it from https:\/\/code\.claude\.com\/docs\/en\/setup, or run: /)
  })

  it("gives every agent its own install page", () => {
    expect(friendlySpawnError(errno("spawn ENOENT", "ENOENT"), "codex"))
      .toBe("Codex isn't installed on this computer.\nInstall it from https://developers.openai.com/codex/cli, or run: npm install -g @openai/codex")
    expect(friendlySpawnError(errno("spawn ENOENT", "ENOENT"), "copilot"))
      .toContain("GitHub Copilot CLI isn't installed on this computer.\nInstall it from https://docs.github.com/")
  })

  it("passes any other failure through untouched", () => {
    expect(friendlySpawnError(errno("something else", "EPERM"), "claude")).toBe("something else")
  })
})

describe("agentNotInstalledError", () => {
  it("carries the code the client reads and the same message", () => {
    const error = agentNotInstalledError("codex")
    expect(error.code).toBe(AGENT_NOT_INSTALLED)
    expect(error.message).toBe(friendlySpawnError(errno("spawn ENOENT", "ENOENT"), "codex"))
  })
})

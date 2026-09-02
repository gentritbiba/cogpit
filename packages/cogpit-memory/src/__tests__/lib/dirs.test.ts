import { describe, expect, it } from "bun:test"
import { agentHomeDir } from "../../lib/dirs"

describe("agentHomeDir", () => {
  it("uses the environment variable each CLI publishes", () => {
    expect(agentHomeDir("copilot", { COPILOT_HOME: "/opt/copilot-data" }, "/Users/me"))
      .toBe("/opt/copilot-data")
    // Codex's override used to be ignored here, so a redirected install was
    // invisible to every command in the package.
    expect(agentHomeDir("codex", { CODEX_HOME: "/opt/codex-data" }, "/Users/me"))
      .toBe("/opt/codex-data")
  })

  it("falls back to the CLI's directory under the user's home", () => {
    expect(agentHomeDir("copilot", {}, "/Users/me")).toBe("/Users/me/.copilot")
    expect(agentHomeDir("codex", {}, "/Users/me")).toBe("/Users/me/.codex")
    expect(agentHomeDir("claude", {}, "/Users/me")).toBe("/Users/me/.claude")
  })
})

// @vitest-environment node
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ path: "", version: null as string | null }))
vi.mock("../../config", () => ({ getConfig: () => ({ agentExecutable: { source: "custom", path: mocks.path } }) }))
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(() => {
    if (mocks.version === null) throw new Error("no answer")
    return `${mocks.version} (Claude Code)\n`
  }),
}))

import { claudeLaunchOptions, INITIALIZE_MCP_DELIVERY_VERSION } from "../../agents/claudeExecutable"

function launchWith(path: string, version: string | null) {
  mocks.path = path
  mocks.version = version
  return claudeLaunchOptions()
}

describe("claudeLaunchOptions", () => {
  it("sends MCP servers in the initialize request to a CLI at least as new as the SDK's own", () => {
    expect(launchWith("/opt/current/claude", "2.1.326")).toEqual({ pathToClaudeCodeExecutable: "/opt/current/claude", mcpServersDelivery: "initialize" })
    expect(launchWith("/opt/newer/claude", "2.2.0")).toEqual({ pathToClaudeCodeExecutable: "/opt/newer/claude", mcpServersDelivery: "initialize" })
  })

  it("keeps them on the command line for an older CLI, or one that will not say its version", () => {
    expect(launchWith("/opt/older/claude", "2.1.306").mcpServersDelivery).toBe("argv")
    expect(launchWith("/opt/silent/claude", null).mcpServersDelivery).toBe("argv")
  })

  it("asks a binary its version once per choice", async () => {
    const { execFileSync } = await import("node:child_process")
    vi.mocked(execFileSync).mockClear()
    launchWith("/opt/once/claude", "2.1.326")
    claudeLaunchOptions()
    expect(execFileSync).toHaveBeenCalledOnce()
  })

  it("names the release the installed Agent SDK bundles", () => {
    const sdkEntry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk")
    const { claudeCodeVersion } = JSON.parse(readFileSync(join(dirname(sdkEntry), "package.json"), "utf-8")) as { claudeCodeVersion: string }
    expect(INITIALIZE_MCP_DELIVERY_VERSION.join(".")).toBe(claudeCodeVersion)
  })
})

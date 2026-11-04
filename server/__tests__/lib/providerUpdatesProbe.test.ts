// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  spawnedExecutableFor: vi.fn(),
  probeCliVersion: vi.fn(),
}))
vi.mock("../../agents/executables", () => ({ spawnedExecutableFor: mocks.spawnedExecutableFor }))
vi.mock("../../lib/cliProcess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/cliProcess")>()),
  probeCliVersion: mocks.probeCliVersion,
}))

import { _resetProviderUpdateCachesForTests, getProviderUpdates } from "../../lib/providerUpdates"

const fetchMock = vi.fn()

beforeEach(() => {
  _resetProviderUpdateCachesForTests()
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ version: "9.9.9" }) })
  mocks.probeCliVersion.mockResolvedValue("2.1.0")
  mocks.spawnedExecutableFor.mockReturnValue(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const entry = async (provider: string) => (await getProviderUpdates()).find((info) => info.provider === provider)!

describe("getProviderUpdates", () => {
  it("counts Cogpit's bundled Claude as installed but never offers an update it cannot run", async () => {
    mocks.spawnedExecutableFor.mockImplementation((kind: string) =>
      kind === "claude" ? { path: "/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude", bundled: true } : null)

    const claude = await entry("claude")

    expect(claude).toMatchObject({ installed: true, installMethod: "bundled", status: "unknown", updateCommand: null, latestVersion: null })
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("claude-code"), expect.anything())
  })

  it("reports an agent with nothing to run as not installed, with the command that installs it here", async () => {
    expect(await entry("codex")).toMatchObject({
      installed: false, status: "not-installed", binaryPath: null, installCommand: "npm install -g @openai/codex",
    })
    expect((await entry("acp")).installCommand).toBeNull()
  })

  it("still compares an installed CLI with the registry", async () => {
    mocks.spawnedExecutableFor.mockImplementation((kind: string) =>
      kind === "codex" ? { path: "/Users/x/.bun/bin/codex", bundled: false } : null)
    expect(await entry("codex")).toMatchObject({ installed: true, installMethod: "bun", status: "behind", latestVersion: "9.9.9" })
  })
})

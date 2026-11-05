// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  existing: new Set(["/sdk/claude", "/bin/claude"]),
  findExecutableOnPath: vi.fn((name: string) => (name.includes("/") ? name : `/usr/local/bin/${name}`)),
  resolveClaudeExecutable: vi.fn(),
}))
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: (path: string) => mocks.existing.has(path),
}))
vi.mock("../../lib/binaryResolver", () => ({ findExecutableOnPath: mocks.findExecutableOnPath }))
vi.mock("../../agents/claudeExecutable", () => ({
  resolveClaudeExecutable: mocks.resolveClaudeExecutable,
  describeClaudeExecutable: vi.fn(),
}))

import { spawnedExecutableFor } from "../../agents/executables"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("spawnedExecutableFor", () => {
  it("says where Claude's binary came from, the SDK's own copy included", () => {
    mocks.resolveClaudeExecutable.mockReturnValue({ source: "bundled", path: "/sdk/claude" })
    expect(spawnedExecutableFor("claude")).toEqual({ path: "/sdk/claude", source: "bundled" })
    mocks.resolveClaudeExecutable.mockReturnValue({ source: "path", path: "/bin/claude" })
    expect(spawnedExecutableFor("claude")).toEqual({ path: "/bin/claude", source: "path" })
    mocks.resolveClaudeExecutable.mockReturnValue(undefined)
    expect(spawnedExecutableFor("claude")).toBeNull()
  })

  it("does not count a configured Claude path that no longer exists", () => {
    mocks.resolveClaudeExecutable.mockReturnValue({ source: "custom", path: "/gone/claude" })
    expect(spawnedExecutableFor("claude")).toBeNull()
  })

  it("finds the other CLIs on PATH", () => {
    expect(spawnedExecutableFor("codex")).toEqual({ path: "/usr/local/bin/codex", source: "path" })
  })

  it("runs an ACP agent only from its configured executable, never a PATH namesake", () => {
    vi.stubEnv("COGPIT_PROVIDER_EXECUTABLE", "")
    expect(spawnedExecutableFor("acp")).toBeNull()
    vi.stubEnv("COGPIT_PROVIDER_EXECUTABLE", "/opt/agents/my-acp")
    expect(spawnedExecutableFor("acp")).toEqual({ path: "/opt/agents/my-acp", source: "custom" })
  })
})

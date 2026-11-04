// @vitest-environment node
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ onPath: undefined as string | undefined }))
vi.mock("../../config", () => ({ getConfig: () => ({ agentExecutable: { source: "path" } }) }))
vi.mock("../../lib/binaryResolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/binaryResolver")>()),
  findExecutableOnPath: () => mocks.onPath,
}))

import { resolveClaudeExecutable } from "../../agents/claudeExecutable"

describe("resolveClaudeExecutable", () => {
  it("notices a CLI installed after an earlier lookup found none", () => {
    expect(resolveClaudeExecutable()).toBeUndefined()
    mocks.onPath = "/usr/local/bin/claude"
    expect(resolveClaudeExecutable()).toEqual({ source: "path", path: "/usr/local/bin/claude" })
    // A found binary stays memoized for its choice.
    mocks.onPath = "/elsewhere/claude"
    expect(resolveClaudeExecutable()?.path).toBe("/usr/local/bin/claude")
  })
})

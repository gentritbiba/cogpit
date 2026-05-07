import { homedir } from "node:os"
import { join } from "node:path"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// We must import after manipulating the env, so we use a dynamic import inside each test
// instead of a top-level import, to avoid module caching issues with env vars.

describe("resolveSearchIndexPath", () => {
  const originalEnv = process.env.COGPIT_DATA_DIR

  beforeEach(() => {
    // Reset the module registry so we always get a fresh evaluation
    vi.resetModules()
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.COGPIT_DATA_DIR
    } else {
      process.env.COGPIT_DATA_DIR = originalEnv
    }
  })

  it("prefers COGPIT_DATA_DIR env var over userDataDir", async () => {
    process.env.COGPIT_DATA_DIR = "/custom/env/dir"
    const { resolveSearchIndexPath } = await import("../../lib/searchIndexPath")
    const result = resolveSearchIndexPath({ userDataDir: "/some/other/dir" })
    expect(result).toBe("/custom/env/dir/search-index.db")
  })

  it("uses userDataDir when COGPIT_DATA_DIR is not set", async () => {
    delete process.env.COGPIT_DATA_DIR
    const { resolveSearchIndexPath } = await import("../../lib/searchIndexPath")
    const result = resolveSearchIndexPath({ userDataDir: "/electron/user-data" })
    expect(result).toBe("/electron/user-data/search-index.db")
  })

  it("falls back to ~/.claude/agent-window when neither is provided", async () => {
    delete process.env.COGPIT_DATA_DIR
    const { resolveSearchIndexPath } = await import("../../lib/searchIndexPath")
    const result = resolveSearchIndexPath()
    expect(result).toBe(join(homedir(), ".claude", "agent-window", "search-index.db"))
  })

  it("falls back to ~/.claude/agent-window when opts is empty object", async () => {
    delete process.env.COGPIT_DATA_DIR
    const { resolveSearchIndexPath } = await import("../../lib/searchIndexPath")
    const result = resolveSearchIndexPath({})
    expect(result).toBe(join(homedir(), ".claude", "agent-window", "search-index.db"))
  })
})

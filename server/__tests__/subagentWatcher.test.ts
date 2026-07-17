// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { readdir, watch } = vi.hoisted(() => ({
  readdir: vi.fn(),
  watch: vi.fn(),
}))

vi.mock("node:fs/promises", () => ({
  readdir,
  stat: vi.fn(),
  open: vi.fn(),
  appendFile: vi.fn(),
}))

vi.mock("node:fs", () => ({ watch }))
vi.mock("../lib/activityMonitor", () => ({ recordActivity: vi.fn() }))

import { watchSubagents } from "../subagentWatcher"

describe("watchSubagents", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    readdir.mockRejectedValue(new Error("missing"))
    watch.mockImplementation(() => { throw new Error("missing") })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("uses a two-second fallback poll and stops it on close", async () => {
    const watcher = watchSubagents(
      "/tmp/session.jsonl",
      "session",
      new Map(),
    )

    expect(readdir).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(readdir).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(readdir).toHaveBeenCalledTimes(2)

    watcher.close()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(readdir).toHaveBeenCalledTimes(2)
  })
})

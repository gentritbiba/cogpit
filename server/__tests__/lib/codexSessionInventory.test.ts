// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getSessionMeta: vi.fn(),
  listCodexSessionFiles: vi.fn(),
  getCodexSessionIdentity: vi.fn(),
}))

vi.mock("../../helpers", () => ({
  getSessionMeta: mocks.getSessionMeta,
  listCodexSessionFiles: mocks.listCodexSessionFiles,
}))

vi.mock("../../sessionMetadata", () => ({
  getCodexSessionIdentity: mocks.getCodexSessionIdentity,
}))

import {
  getCodexSessionInventory,
  invalidateCodexSessionInventory,
} from "../../lib/codexSessionInventory"

const file = {
  filePath: "/sessions/rollout.jsonl",
  fileName: "rollout.jsonl",
  mtimeMs: 1000,
  size: 500,
}

const identity = {
  sessionId: "session-1",
  cwd: "/code/project",
  gitBranch: "main",
  isSubagent: false,
  parentSessionId: null,
}

describe("codexSessionInventory", () => {
  beforeEach(() => {
    invalidateCodexSessionInventory()
    vi.resetAllMocks()
    mocks.listCodexSessionFiles.mockResolvedValue([file])
    mocks.getCodexSessionIdentity.mockResolvedValue(identity)
  })

  it("shares one cold load across concurrent callers", async () => {
    const [first, second] = await Promise.all([
      getCodexSessionInventory(),
      getCodexSessionInventory(),
    ])

    expect(first).toEqual([{ ...file, ...identity }])
    expect(second).toBe(first)
    expect(mocks.listCodexSessionFiles).toHaveBeenCalledTimes(1)
    expect(mocks.getCodexSessionIdentity).toHaveBeenCalledTimes(1)
  })

  it("reuses the recent inventory without touching the filesystem", async () => {
    await getCodexSessionInventory()
    await getCodexSessionInventory()

    expect(mocks.listCodexSessionFiles).toHaveBeenCalledTimes(1)
  })

  it("falls back to rich metadata for a legacy header", async () => {
    mocks.getCodexSessionIdentity.mockResolvedValueOnce(null)
    mocks.getSessionMeta.mockResolvedValueOnce({ ...identity, model: "gpt-5" })

    await expect(getCodexSessionInventory()).resolves.toEqual([{ ...file, ...identity }])
    expect(mocks.getSessionMeta).toHaveBeenCalledWith(file.filePath)
  })
})

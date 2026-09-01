// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getSessionMeta: vi.fn(),
  listCopilotSessionFiles: vi.fn(),
  getCopilotSessionIdentity: vi.fn(),
}))

vi.mock("../../helpers", () => ({
  getSessionMeta: mocks.getSessionMeta,
  listCopilotSessionFiles: mocks.listCopilotSessionFiles,
}))

vi.mock("../../sessionMetadata", () => ({
  getCopilotSessionIdentity: mocks.getCopilotSessionIdentity,
}))

import {
  getCopilotSessionInventory,
  invalidateCopilotSessionInventory,
} from "../../lib/copilotSessionInventory"

const sessionId = "68596e24-db5d-46a4-86fe-9d82425f36d7"
const file = {
  filePath: `/sessions/${sessionId}/events.jsonl`,
  fileName: `${sessionId}/events.jsonl`,
  mtimeMs: 1000,
  size: 500,
}
const identity = {
  sessionId,
  cwd: "/code/project",
  gitBranch: "main",
  isSubagent: false as const,
  parentSessionId: null,
}

describe("copilotSessionInventory", () => {
  beforeEach(() => {
    invalidateCopilotSessionInventory()
    vi.resetAllMocks()
    mocks.listCopilotSessionFiles.mockResolvedValue([file])
    mocks.getCopilotSessionIdentity.mockResolvedValue(identity)
  })

  it("shares one cold load and preserves provider file identity", async () => {
    const [first, second] = await Promise.all([
      getCopilotSessionInventory(),
      getCopilotSessionInventory(),
    ])

    expect(first).toEqual([{ ...file, ...identity }])
    expect(second).toBe(first)
    expect(mocks.listCopilotSessionFiles).toHaveBeenCalledTimes(1)
    expect(mocks.getCopilotSessionIdentity).toHaveBeenCalledTimes(1)
  })

  it("uses the directory UUID even when transcript metadata disagrees", async () => {
    mocks.getCopilotSessionIdentity.mockResolvedValueOnce({
      ...identity,
      sessionId: "wrong-id",
    })

    await expect(getCopilotSessionInventory()).resolves.toEqual([
      { ...file, ...identity },
    ])
  })

  it("falls back to rich metadata without turning events.jsonl into the session id", async () => {
    mocks.getCopilotSessionIdentity.mockResolvedValueOnce(null)
    mocks.getSessionMeta.mockResolvedValueOnce({
      sessionId: "",
      cwd: "/code/project",
      gitBranch: "feature/copilot",
    })

    await expect(getCopilotSessionInventory()).resolves.toEqual([{
      ...file,
      ...identity,
      gitBranch: "feature/copilot",
    }])
  })

  it("drops fallback entries that cannot be assigned to a project", async () => {
    mocks.getCopilotSessionIdentity.mockResolvedValueOnce(null)
    mocks.getSessionMeta.mockResolvedValueOnce({ sessionId: "", cwd: "", gitBranch: "" })

    await expect(getCopilotSessionInventory()).resolves.toEqual([])
  })
})

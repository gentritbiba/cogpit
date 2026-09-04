// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  listTopLevelSessions: vi.fn(),
  getSessionPrSearchSnapshot: vi.fn(),
  getSessionMeta: vi.fn(),
  getSessionStatus: vi.fn(),
}))

vi.mock("../../agents", () => ({
  allStores: () => [{ listTopLevelSessions: mocks.listTopLevelSessions }],
}))
vi.mock("../../lib/sessionPrSearchIndex", () => ({
  getSessionPrSearchSnapshot: mocks.getSessionPrSearchSnapshot,
}))
vi.mock("../../helpers", () => ({
  getSessionMeta: mocks.getSessionMeta,
  getSessionStatus: mocks.getSessionStatus,
}))

import { listProjectPullRequestSessions } from "../../lib/projectPullRequestSessions"

function session(fileName: string, projectPath: string, mtimeMs: number) {
  return { filePath: `/sessions/${fileName}`, fileName, dirName: "-repo", projectPath, mtimeMs, size: 10 }
}

describe("listProjectPullRequestSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSessionStatus.mockResolvedValue({ status: "idle" })
    mocks.getSessionMeta.mockImplementation(async (filePath: string) => ({
      sessionId: filePath.includes("older") ? "older-id" : "newer-id",
      customTitle: "",
      aiTitle: filePath.includes("older") ? "Fix checkout" : "",
      firstUserMessage: "ship it",
      slug: "",
    }))
  })

  it("keeps only this project's sessions that reference the repository's pull requests", async () => {
    mocks.listTopLevelSessions.mockResolvedValue([
      session("older.jsonl", "/repo", 1),
      session("newer.jsonl", "/repo", 2),
      session("quiet.jsonl", "/repo", 3),
      session("elsewhere.jsonl", "/other", 4),
    ])
    mocks.getSessionPrSearchSnapshot.mockResolvedValue({
      pending: 1,
      total: 3,
      byFile: new Map([
        ["/sessions/older.jsonl", { pullRequests: [], references: [{ number: 128, repo: "acme/app" }, { number: 128, repo: "" }] }],
        ["/sessions/newer.jsonl", { pullRequests: [], references: [{ number: 7, repo: "other/repo" }, { number: 130, repo: "" }] }],
        ["/sessions/quiet.jsonl", { pullRequests: [], references: [] }],
      ]),
    })

    const result = await listProjectPullRequestSessions("/repo", "acme/app")

    expect(result.pending).toBe(1)
    expect(result.sessions).toEqual([
      { dirName: "-repo", fileName: "newer.jsonl", sessionId: "newer-id", title: "ship it", numbers: [130] },
      { dirName: "-repo", fileName: "older.jsonl", sessionId: "older-id", title: "Fix checkout", numbers: [128] },
    ])
    const scanned = mocks.getSessionPrSearchSnapshot.mock.calls[0][0] as Array<{ fileName: string }>
    expect(scanned.map((candidate) => candidate.fileName)).toEqual(["quiet.jsonl", "newer.jsonl", "older.jsonl"])
  })
})

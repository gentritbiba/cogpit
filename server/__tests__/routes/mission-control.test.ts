// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getSessionInventory: vi.fn(),
  listClaudeSessionFiles: vi.fn(),
  summarizeSession: vi.fn(),
}))

vi.mock("../../agents", () => ({
  storeFor: () => ({ listSessionFiles: mocks.listClaudeSessionFiles }),
}))
vi.mock("../../lib/sessionInventory", () => ({
  getSessionInventory: mocks.getSessionInventory,
}))
vi.mock("../../lib/missionControlSummary", () => ({
  summarizeSession: mocks.summarizeSession,
}))

import { handleMissionControl } from "../../routes/mission-control"
import { asIncomingMessage, asServerResponse } from "../http-fixtures"

describe("GET /api/mission-control", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listClaudeSessionFiles.mockResolvedValue([])
    mocks.getSessionInventory.mockResolvedValue([])
    mocks.summarizeSession.mockImplementation(async (sessionId: string) => ({ sessionId }))
  })

  it("includes root Copilot sessions and skips nested agents", async () => {
    mocks.getSessionInventory.mockImplementation(async (kind: string) => kind !== "copilot" ? [] : [
      {
        sessionId: "11111111-1111-4111-8111-111111111111",
        filePath: "/tmp/copilot/11111111-1111-4111-8111-111111111111/events.jsonl",
        mtimeMs: 200,
        isSubagent: false,
      },
      {
        sessionId: "22222222-2222-4222-8222-222222222222",
        filePath: "/tmp/copilot/22222222-2222-4222-8222-222222222222/events.jsonl",
        mtimeMs: 100,
        isSubagent: true,
      },
    ])
    let responseBody = ""
    const req = asIncomingMessage({ method: "GET", url: "/?limit=10" })
    const res = asServerResponse({
      statusCode: 0,
      setHeader: vi.fn(),
      end: (body?: string) => { responseBody = body ?? "" },
    })
    const next = vi.fn()

    await handleMissionControl(req, res, next)

    expect(mocks.summarizeSession).toHaveBeenCalledOnce()
    expect(mocks.summarizeSession).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "/tmp/copilot/11111111-1111-4111-8111-111111111111/events.jsonl",
    )
    expect(JSON.parse(responseBody).summaries).toEqual([
      { sessionId: "11111111-1111-4111-8111-111111111111" },
    ])
    expect(next).not.toHaveBeenCalled()
  })
})

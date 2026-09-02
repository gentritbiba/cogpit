// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  listTopLevelSessions: vi.fn(),
  summarizeSession: vi.fn(),
}))

vi.mock("../../agents", () => ({
  allStores: () => [{ listTopLevelSessions: mocks.listTopLevelSessions }],
}))
vi.mock("../../lib/missionControlSummary", () => ({
  summarizeSession: mocks.summarizeSession,
}))

import { handleMissionControl } from "../../routes/mission-control"
import { asIncomingMessage, asServerResponse } from "../http-fixtures"

async function run(url: string): Promise<{ body: string; next: ReturnType<typeof vi.fn> }> {
  let body = ""
  const req = asIncomingMessage({ method: "GET", url })
  const res = asServerResponse({
    statusCode: 0,
    setHeader: vi.fn(),
    end: (chunk?: string) => { body = chunk ?? "" },
  })
  const next = vi.fn()
  await handleMissionControl(req, res, next)
  return { body, next }
}

describe("GET /api/mission-control", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listTopLevelSessions.mockResolvedValue([])
    mocks.summarizeSession.mockImplementation(async (sessionId: string) => ({ sessionId }))
  })

  it("summarises the sessions every store lists, newest first", async () => {
    mocks.listTopLevelSessions.mockResolvedValue([
      {
        sessionId: "22222222-2222-4222-8222-222222222222",
        fileName: "22222222-2222-4222-8222-222222222222/events.jsonl",
        filePath: "/tmp/copilot/22222222-2222-4222-8222-222222222222/events.jsonl",
        mtimeMs: 100,
      },
      {
        sessionId: "11111111-1111-4111-8111-111111111111",
        fileName: "11111111-1111-4111-8111-111111111111/events.jsonl",
        filePath: "/tmp/copilot/11111111-1111-4111-8111-111111111111/events.jsonl",
        mtimeMs: 200,
      },
    ])

    const { body, next } = await run("/?limit=10")

    expect(mocks.summarizeSession).toHaveBeenCalledTimes(2)
    expect(JSON.parse(body).summaries).toEqual([
      { sessionId: "11111111-1111-4111-8111-111111111111" },
      { sessionId: "22222222-2222-4222-8222-222222222222" },
    ])
    expect(next).not.toHaveBeenCalled()
  })

  it("names a session after its file when the listing carries no id", async () => {
    mocks.listTopLevelSessions.mockResolvedValue([
      {
        fileName: "33333333-3333-4333-8333-333333333333.jsonl",
        filePath: "/tmp/projects/proj/33333333-3333-4333-8333-333333333333.jsonl",
        mtimeMs: 300,
      },
    ])

    await run("/?limit=10")

    expect(mocks.summarizeSession).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      "/tmp/projects/proj/33333333-3333-4333-8333-333333333333.jsonl",
    )
  })
})

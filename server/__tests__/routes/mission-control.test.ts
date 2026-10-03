// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  allTopLevelSessions: vi.fn(),
  summarizeSession: vi.fn(),
}))

vi.mock("../../agents", () => ({
  allTopLevelSessions: mocks.allTopLevelSessions,
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
    mocks.allTopLevelSessions.mockResolvedValue([])
    mocks.summarizeSession.mockImplementation(async (sessionId: string) => ({ sessionId }))
  })

  it("summarises the newest sessions every store lists, up to the limit", async () => {
    mocks.allTopLevelSessions.mockResolvedValue(["1", "2", "3"].map((digit) => {
      const sessionId = `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`
      return { sessionId, fileName: `${sessionId}/events.jsonl`, filePath: `/tmp/copilot/${sessionId}/events.jsonl`, mtimeMs: 300 - Number(digit) }
    }))

    const { body, next } = await run("/?limit=2")

    expect(mocks.summarizeSession).toHaveBeenCalledTimes(2)
    expect(JSON.parse(body).summaries).toEqual([
      { sessionId: "11111111-1111-4111-8111-111111111111" },
      { sessionId: "22222222-2222-4222-8222-222222222222" },
    ])
    expect(next).not.toHaveBeenCalled()
  })

  it("summarises the stores that can list their sessions when another cannot", async () => {
    const { createStoreRegistry } = await vi.importActual<typeof import("../../agents")>("../../agents")
    const sessionId = "44444444-4444-4444-8444-444444444444"
    const listing = (sessions: object[], error?: Error) => ({
      listTopLevelSessions: async () => {
        if (error) throw error
        return sessions
      },
    })
    const registry = createStoreRegistry({
      claude: listing([], Object.assign(new Error("EACCES"), { code: "EACCES" })),
      codex: listing([{ sessionId, fileName: `${sessionId}.jsonl`, filePath: `/tmp/codex/${sessionId}.jsonl`, mtimeMs: 1 }]),
      copilot: listing([]),
    } as unknown as Parameters<typeof createStoreRegistry>[0])
    mocks.allTopLevelSessions.mockImplementation(registry.allTopLevelSessions)

    const { body } = await run("/?limit=10")

    expect(JSON.parse(body).summaries).toEqual([{ sessionId }])
  })

  it("names a session after its file when the listing carries no id", async () => {
    mocks.allTopLevelSessions.mockResolvedValue([
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

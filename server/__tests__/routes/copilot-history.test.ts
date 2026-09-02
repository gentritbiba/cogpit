// @vitest-environment node
import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../../helpers"
import type { CopilotRuntime } from "../../agents/copilotTransport"
import { registerCopilotHistoryRoutes } from "../../routes/copilot-history"

const { mockFindJsonlPath, mockOwnsPath } = vi.hoisted(() => ({
  mockFindJsonlPath: vi.fn(),
  mockOwnsPath: vi.fn(),
}))

vi.mock("../../sessionPaths", () => ({
  findJsonlPath: (...args: unknown[]) => mockFindJsonlPath(...args),
}))

vi.mock("../../agents", () => ({
  storeFor: () => ({ ownsPath: (...args: unknown[]) => mockOwnsPath(...args) }),
}))

type HistoryClient = Pick<
  CopilotRuntime,
  "isSessionActive" | "resumeSession" | "destroySession" | "previewRewind" | "rewind"
>

function client(active = false): HistoryClient {
  let sessionActive = active
  return {
    isSessionActive: vi.fn(() => sessionActive),
    resumeSession: vi.fn().mockImplementation(async () => {
      sessionActive = true
      return { sessionId: "session-1" }
    }),
    destroySession: vi.fn().mockImplementation(async () => {
      sessionActive = false
    }),
    previewRewind: vi.fn().mockResolvedValue({
      available: true,
      fileCount: 1,
      files: [{
        path: "/workspace/app.ts",
        changeType: "modified",
        linesAdded: 1,
        linesRemoved: 0,
      }],
    }),
    rewind: vi.fn().mockResolvedValue({
      outcome: "success",
      restoredFiles: ["/workspace/app.ts"],
      skippedFiles: [],
    }),
  }
}

function handler(runtime: HistoryClient): Middleware {
  let registered: Middleware | undefined
  const use: UseFn = (_path, route) => { registered = route }
  registerCopilotHistoryRoutes(use, runtime)
  if (!registered) throw new Error("Copilot history route was not registered")
  return registered
}

async function invoke(
  route: Middleware,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ statusCode: number; json: unknown }> {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string }
  req.method = method
  req.url = url
  let statusCode = 200
  let payload = ""
  const res = {
    get statusCode() { return statusCode },
    set statusCode(value: number) { statusCode = value },
    setHeader: vi.fn(),
    end: vi.fn((value?: string) => { payload = value ?? "" }),
  }
  route(
    req as unknown as Parameters<Middleware>[0],
    res as unknown as Parameters<Middleware>[1],
    vi.fn(),
  )
  if (body !== undefined) req.emit("data", JSON.stringify(body))
  req.emit("end")
  await vi.waitFor(() => expect(res.end).toHaveBeenCalled())
  return { statusCode, json: JSON.parse(payload) as unknown }
}

beforeEach(() => {
  mockFindJsonlPath.mockReset().mockResolvedValue(
    "/home/test/.copilot/session-state/session-1/events.jsonl",
  )
  mockOwnsPath.mockReset().mockReturnValue(true)
})

describe("Copilot history routes", () => {
  it("resumes an inactive Copilot session before previewing a rewind", async () => {
    const runtime = client(false)
    const response = await invoke(
      handler(runtime),
      "POST",
      "/session-1/preview",
      { eventId: "user-event-1" },
    )

    expect(response.statusCode).toBe(200)
    expect(runtime.resumeSession).toHaveBeenCalledWith("session-1")
    expect(runtime.previewRewind).toHaveBeenCalledWith("session-1", "user-event-1")
    expect(runtime.destroySession).toHaveBeenCalledWith("session-1")
    expect(response.json).toMatchObject({ available: true, fileCount: 1 })
  })

  it("rewinds an active session without resuming it again", async () => {
    const runtime = client(true)
    const response = await invoke(
      handler(runtime),
      "POST",
      "/session-1/rewind",
      { eventId: "user-event-1", mode: "conversation-and-files" },
    )

    expect(response.statusCode).toBe(200)
    expect(runtime.resumeSession).not.toHaveBeenCalled()
    expect(runtime.destroySession).not.toHaveBeenCalled()
    expect(runtime.rewind).toHaveBeenCalledWith(
      "session-1",
      "user-event-1",
      "conversation-and-files",
    )
  })

  it("rejects non-Copilot sessions", async () => {
    mockOwnsPath.mockReturnValue(false)
    const runtime = client(false)
    const response = await invoke(
      handler(runtime),
      "POST",
      "/session-1/preview",
      { eventId: "user-event-1" },
    )

    expect(response.statusCode).toBe(404)
    expect(runtime.resumeSession).not.toHaveBeenCalled()
  })

  it("validates rewind mode before opening the session", async () => {
    const runtime = client(false)
    const response = await invoke(
      handler(runtime),
      "POST",
      "/session-1/rewind",
      { eventId: "user-event-1", mode: "files" },
    )

    expect(response.statusCode).toBe(400)
    expect(runtime.resumeSession).not.toHaveBeenCalled()
  })
})

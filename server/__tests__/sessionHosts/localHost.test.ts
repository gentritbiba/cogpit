// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  sendToSession: vi.fn(),
  recordTurnError: vi.fn(),
  clearTurnError: vi.fn(),
  interrupt: vi.fn(),
}))

vi.mock("../../lib/sessionCreate", () => ({ createSession: mocks.createSession }))
vi.mock("../../lib/sessionSend", () => ({ sendToSession: mocks.sendToSession }))
vi.mock("../../lib/projectList", () => ({ listAllProjects: vi.fn() }))
vi.mock("../../lib/sessionWait", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  recordTurnError: mocks.recordTurnError,
  clearTurnError: mocks.clearTurnError,
}))
vi.mock("../../agents/runtimes", () => ({
  resolveSessionAgent: async () => ({ kind: "k", filePath: null }),
  runtimeFor: () => ({ interrupt: mocks.interrupt }),
  runtimeForSession: () => null,
}))

import { localHost } from "../../sessionHosts/localHost"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("localHost", () => {
  it("creates with the caller's retry key and permission mode", async () => {
    mocks.createSession.mockResolvedValue({ sessionId: "s1", dirName: "-work-app", fileName: "s1.jsonl" })
    expect(await localHost.create({
      cwd: "/work/app",
      message: "hi",
      mode: "bypassPermissions",
      requestId: "req-1",
      scope: "local",
    })).toEqual({ sessionId: "s1", dirName: "-work-app" })
    expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/work/app",
      permissions: { mode: "bypassPermissions" },
      retry: { requestId: "req-1", scope: "local" },
    }))
  })

  it("interrupts first when asked and keeps a resume failure for wait", async () => {
    let settle: (value: { isError: boolean; message?: string }) => void = () => {}
    mocks.sendToSession.mockResolvedValue({
      outcome: { delivery: "started", completion: new Promise((resolve) => { settle = resolve }) },
    })
    expect(await localHost.send("s1", "and now docs", { interrupt: true })).toEqual({ delivery: "started" })
    expect(mocks.interrupt).toHaveBeenCalledWith("s1")
    expect(mocks.clearTurnError).toHaveBeenCalledWith("s1")
    expect(mocks.sendToSession).toHaveBeenCalledWith("s1", { message: "and now docs" })

    settle({ isError: true, message: "resume failed" })
    await vi.waitFor(() => expect(mocks.recordTurnError).toHaveBeenCalledWith("s1", "resume failed"))
  })
})

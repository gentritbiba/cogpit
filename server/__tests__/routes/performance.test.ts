// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("../../lib/systemProcesses", () => ({
  captureSystemProcesses: vi.fn(),
}))

vi.mock("../../lib/leakReaper", () => ({
  startLeakReaper: vi.fn(),
  getRecentlyReaped: vi.fn(() => []),
  killPids: vi.fn(() => []),
}))

import type { SystemProcessesSnapshot } from "../../../shared/contracts/performance"
import { captureSystemProcesses } from "../../lib/systemProcesses"
import { registerPerformanceRoutes } from "../../routes/performance"
import { __resetEditionForTest } from "../../edition"
import { useAccountSignIn } from "../edition/fakeEdition"
import { setRequestPrincipal } from "../../requestPrincipal"
import type { SessionPrincipal } from "../../sessionConstants"
import type { Middleware, UseFn } from "../../http"
import { asIncomingMessage, asServerResponse, getRouteHandler } from "../http-fixtures"

const ADMIN: SessionPrincipal = { userId: "u-admin", username: "alice", role: "admin" }
const MEMBER: SessionPrincipal = { userId: "u-member", username: "bob", role: "member" }

const systemFixture: SystemProcessesSnapshot = {
  capturedAt: 123,
  processes: [{
    pid: 4242,
    kind: "claude",
    label: "claude",
    command: "claude --resume abc",
    cpuPercent: 12,
    memoryMb: 80,
    ageSeconds: 60,
    orphaned: false,
    suspectedLeak: false,
  }],
  suspectedLeakCount: 0,
}

const mockedCapture = vi.mocked(captureSystemProcesses)

const originalEditionEnv = process.env.COGPIT_EDITION

function createMockReqRes(principal?: SessionPrincipal) {
  let body = ""
  let resolveEnded = () => {}
  const ended = new Promise<void>((resolve) => { resolveEnded = resolve })
  const req = asIncomingMessage({ method: "GET", url: "/", headers: {} })
  if (principal) setRequestPrincipal(req, principal)
  const res = asServerResponse({
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((data?: string) => {
      body = data ?? ""
      resolveEnded()
    }),
  })
  const next = vi.fn()
  return { req, res, next, ended, getBody: () => body }
}

describe("GET /api/performance system snapshot gating", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.COGPIT_EDITION
    mockedCapture.mockResolvedValue(systemFixture)
    handlers = new Map()
    const use: UseFn = (path, handler) => { handlers.set(path, handler) }
    registerPerformanceRoutes(use)
  })

  afterEach(() => {
    __resetEditionForTest()
    if (originalEditionEnv === undefined) delete process.env.COGPIT_EDITION
    else process.env.COGPIT_EDITION = originalEditionEnv
  })

  async function fetchSnapshot(principal?: SessionPrincipal) {
    const handler = getRouteHandler(handlers, "/api/performance")
    const mock = createMockReqRes(principal)
    handler(mock.req, mock.res, mock.next)
    await mock.ended
    expect(mock.next).not.toHaveBeenCalled()
    return JSON.parse(mock.getBody()) as Record<string, unknown>
  }

  it("includes the system snapshot in personal edition (regression pin)", async () => {
    const snapshot = await fetchSnapshot()
    expect(snapshot.system).toEqual(systemFixture)
  })

  it("includes the system snapshot for an account the edition lets act host-wide", async () => {
    useAccountSignIn()
    const snapshot = await fetchSnapshot(ADMIN)
    expect(snapshot.system).toEqual(systemFixture)
  })

  it("omits the system snapshot for an account the edition does not let act host-wide", async () => {
    useAccountSignIn()
    const snapshot = await fetchSnapshot(MEMBER)
    expect("system" in snapshot).toBe(false)
    expect(mockedCapture).not.toHaveBeenCalled()
  })

  it("omits the system snapshot for principal-less requests where accounts sign in", async () => {
    useAccountSignIn()
    const snapshot = await fetchSnapshot()
    expect("system" in snapshot).toBe(false)
    expect(mockedCapture).not.toHaveBeenCalled()
  })

  it("still ships the core snapshot fields a member's perf panel reads", async () => {
    useAccountSignIn()
    const snapshot = await fetchSnapshot(MEMBER)
    for (const key of ["cpuPercent", "eventLoopPercent", "memory", "activities", "requests", "sampleWindowSeconds"]) {
      expect(snapshot).toHaveProperty(key)
    }
  })
})

// @vitest-environment node
import { Readable } from "node:stream"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockGetProviderUpdates = vi.hoisted(() => vi.fn())
const mockRunProviderUpdate = vi.hoisted(() => vi.fn())

vi.mock("../../lib/providerUpdates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/providerUpdates")>()
  return {
    ...actual,
    getProviderUpdates: mockGetProviderUpdates,
    runProviderUpdate: mockRunProviderUpdate,
  }
})

import type { Middleware, UseFn } from "../../http"
import { registerProviderUpdateRoutes } from "../../routes/provider-updates"
import { asIncomingMessage, asServerResponse, getRouteHandler } from "../http-fixtures"

const claudeInfo = {
  provider: "claude" as const,
  displayName: "Claude Code",
  packageName: "@anthropic-ai/claude-code",
  installed: true,
  binaryPath: "/usr/local/bin/claude",
  currentVersion: "2.1.19",
  latestVersion: "2.1.20",
  status: "behind" as const,
  installMethod: "npm" as const,
  updateCommand: "npm install -g @anthropic-ai/claude-code@latest",
  checkedAt: "2026-08-21T00:00:00.000Z",
}

function handlers(): Map<string, Middleware> {
  const registered = new Map<string, Middleware>()
  const use: UseFn = (path, handler) => { registered.set(path, handler) }
  registerProviderUpdateRoutes(use)
  return registered
}

function makeResponse() {
  let body = ""
  const res = asServerResponse({
    statusCode: 200,
    headersSent: false,
    setHeader: vi.fn(),
    end: (data?: string) => { body = data ?? "" },
  })
  return { res, json: () => JSON.parse(body) }
}

async function get(url: string) {
  const { res, json } = makeResponse()
  const next = vi.fn()
  await getRouteHandler(handlers(), "/api/provider-updates")(
    asIncomingMessage({ method: "GET", url }),
    res,
    next,
  )
  return { res, next, json }
}

async function post(body: unknown) {
  const { res, json } = makeResponse()
  const next = vi.fn()
  const req = asIncomingMessage(
    Object.assign(Readable.from([JSON.stringify(body)]), {
      method: "POST",
      url: "/",
      headers: {} as Record<string, string>,
    }),
  )
  await getRouteHandler(handlers(), "/api/provider-updates/run")(req, res, next)
  // withJsonBody drains the stream before the handler runs.
  await vi.waitFor(() => expect(res.setHeader).toHaveBeenCalled())
  return { res, next, json }
}

describe("GET /api/provider-updates", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProviderUpdates.mockResolvedValue([claudeInfo])
  })

  it("returns the advisory list", async () => {
    const { res, json } = await get("/")
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ providers: [claudeInfo] })
  })

  it("passes sub-paths and non-GET methods through", async () => {
    const nested = await get("/run")
    expect(nested.next).toHaveBeenCalledOnce()
    expect(mockGetProviderUpdates).not.toHaveBeenCalled()
  })

  it("reports probe failures as 500", async () => {
    mockGetProviderUpdates.mockRejectedValue(new Error("probe exploded"))
    const { res } = await get("/")
    expect(res.statusCode).toBe(500)
  })
})

describe("POST /api/provider-updates/run", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunProviderUpdate.mockResolvedValue({
      provider: "claude",
      status: "succeeded",
      message: "Claude Code updated to 2.1.20.",
      output: null,
      info: { ...claudeInfo, currentVersion: "2.1.20", status: "current" },
    })
  })

  it("runs the update for a known provider", async () => {
    const { res, json } = await post({ provider: "claude" })
    expect(mockRunProviderUpdate).toHaveBeenCalledWith("claude")
    expect(res.statusCode).toBe(200)
    expect(json().status).toBe("succeeded")
  })

  it("accepts Copilot as a known provider", async () => {
    const { res } = await post({ provider: "copilot" })
    expect(mockRunProviderUpdate).toHaveBeenCalledWith("copilot")
    expect(res.statusCode).toBe(200)
  })

  it("rejects an unknown provider without spawning anything", async () => {
    const { res, json } = await post({ provider: "rm -rf /" })
    expect(res.statusCode).toBe(400)
    expect(json().error).toContain("copilot")
    expect(mockRunProviderUpdate).not.toHaveBeenCalled()
  })

  it("answers 500 when the update command fails", async () => {
    mockRunProviderUpdate.mockResolvedValue({
      provider: "claude",
      status: "failed",
      message: "`npm install -g …` exited with code 1.",
      output: "EACCES",
      info: claudeInfo,
    })
    const { res, json } = await post({ provider: "claude" })
    expect(res.statusCode).toBe(500)
    expect(json().output).toBe("EACCES")
  })
})

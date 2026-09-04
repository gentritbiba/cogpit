// @vitest-environment node
import { Readable } from "node:stream"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ describe: vi.fn(), switchTo: vi.fn() }))
vi.mock("../../agents/accounts", () => ({
  accountSwitcherFor: (kind: string) =>
    kind === "claude" ? { describe: mocks.describe, switchTo: mocks.switchTo } : null,
}))

import type { Middleware, UseFn } from "../../http"
import { registerAgentAccountRoutes } from "../../routes/agent-accounts"
import { asIncomingMessage, asServerResponse } from "../http-fixtures"

function handler(): Middleware {
  let registered: Middleware | undefined
  const use: UseFn = (_path, middleware) => { registered = middleware }
  registerAgentAccountRoutes(use)
  return registered!
}

function makeResponse() {
  const raw = {
    statusCode: 200,
    headersSent: false,
    setHeader: vi.fn(),
    body: "",
    end(chunk?: string) { this.body = chunk ?? "" },
  }
  return { res: asServerResponse(raw), raw, json: () => JSON.parse(raw.body) }
}

async function get(url: string) {
  const { res, raw, json } = makeResponse()
  const next = vi.fn()
  await handler()(asIncomingMessage({ method: "GET", url }), res, next)
  return { raw, next, json }
}

async function post(url: string, body: unknown) {
  const { res, raw, json } = makeResponse()
  const next = vi.fn()
  const req = asIncomingMessage(Object.assign(Readable.from([JSON.stringify(body)]), {
    method: "POST",
    url,
    headers: {} as Record<string, string>,
  }))
  await handler()(req, res, next)
  if (!next.mock.calls.length) await vi.waitFor(() => expect(raw.setHeader).toHaveBeenCalled())
  return { raw, next, json }
}

const REPORT = {
  status: "ok",
  tool: "claude-swap",
  version: "0.26.0",
  activeSlot: 2,
  accounts: [{ slot: 1, alias: "work", email: "work@example.com", organization: null, active: false, disabled: false, usageStatus: "ok", usage: null }],
}

describe("GET /api/agent-accounts/:kind", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("returns the switcher's report", async () => {
    mocks.describe.mockResolvedValue(REPORT)
    const { raw, json, next } = await get("/claude")
    expect(raw.statusCode).toBe(200)
    expect(json()).toEqual(REPORT)
    expect(next).not.toHaveBeenCalled()
  })

  it("passes the missing state through unchanged", async () => {
    mocks.describe.mockResolvedValue({ status: "missing" })
    const { json } = await get("/claude")
    expect(json()).toEqual({ status: "missing" })
  })

  it("404s for an agent without a switcher", async () => {
    const { raw, next } = await get("/codex")
    expect(raw.statusCode).toBe(404)
    expect(next).not.toHaveBeenCalled()
    expect(mocks.describe).not.toHaveBeenCalled()
  })

  it("passes unknown kinds and stray sub-paths along", async () => {
    expect((await get("/vim")).next).toHaveBeenCalled()
    expect((await get("/claude/switch")).next).toHaveBeenCalled()
    expect((await get("/claude/switch/extra")).next).toHaveBeenCalled()
    expect(mocks.describe).not.toHaveBeenCalled()
  })

  it("reports describe failures as 500", async () => {
    mocks.describe.mockRejectedValue(new Error("boom"))
    expect((await get("/claude")).raw.statusCode).toBe(500)
  })
})

describe("POST /api/agent-accounts/:kind/switch", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("switches to the requested slot", async () => {
    const result = { switched: true, message: "Switched to Account-1", warnings: [], credentialStore: "keychain" }
    mocks.switchTo.mockResolvedValue(result)
    const { raw, json } = await post("/claude/switch", { slot: 1 })
    expect(mocks.switchTo).toHaveBeenCalledWith(1)
    expect(raw.statusCode).toBe(200)
    expect(json()).toEqual(result)
  })

  it("rejects a slot that is not a positive integer without spawning", async () => {
    for (const slot of ["1", 0, 2.5, undefined]) {
      const { raw } = await post("/claude/switch", { slot })
      expect(raw.statusCode).toBe(400)
    }
    expect(mocks.switchTo).not.toHaveBeenCalled()
  })

  it("reports a failed switch with the switcher's message", async () => {
    mocks.switchTo.mockRejectedValue(new Error("Account 9 not found"))
    const { raw, json } = await post("/claude/switch", { slot: 9 })
    expect(raw.statusCode).toBe(500)
    expect(json()).toEqual({ error: "Account 9 not found" })
  })

  it("404s for an agent without a switcher", async () => {
    const { raw } = await post("/codex/switch", { slot: 1 })
    expect(raw.statusCode).toBe(404)
  })

  it("passes a POST to the list path along", async () => {
    expect((await post("/claude", { slot: 1 })).next).toHaveBeenCalled()
  })
})

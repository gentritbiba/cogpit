// @vitest-environment node
import type { IncomingMessage, ServerResponse } from "node:http"
import { describe, expect, it, vi } from "vitest"
import { ALL_CAPABILITIES } from "../../../shared/contracts/identity"
import type { AgentRuntime } from "../../agents/runtimeTypes"
import {
  authorizeSession,
  authorizeStreamSession,
  editionAuthz,
  editionModule,
  editionOwnsSignIn,
  filterVisible,
  handPrompt,
  markDecided,
  mayActHostWide,
  parseScope,
  recordSessionOwner,
  removeSessionAccess,
  reportAuthEvent,
  reportSessionEvent,
  sendTurn,
  startTurn,
  visibilityFor,
} from "../../edition"
import type { UseFn } from "../../http"
import { createMiddlewareRes } from "../http-fixtures"

const req = { method: "GET", url: "/api/x", headers: {} } as IncomingMessage
const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e"

describe("personal edition", () => {
  it("allows every session without reading anything, answering with the id the ref spells", async () => {
    const mock = createMiddlewareRes()
    const { res } = mock
    await expect(authorizeSession(req, res, { sessionId: "not-a-uuid" }, "own"))
      .resolves.toEqual({ sessionId: "not-a-uuid", filePath: null, isRootTranscript: true })
    await expect(authorizeSession(req, res, { dirName: "-Users-me-proj", fileName: `${SESSION}.jsonl` }, "interact"))
      .resolves.toEqual({ sessionId: SESSION, filePath: null, isRootTranscript: true })
    await expect(authorizeSession(req, res, { dirName: "-Users-me-proj", fileName: `${SESSION}/subagents/agent-a1.jsonl` }, "view"))
      .resolves.toEqual({ sessionId: SESSION, filePath: null, isRootTranscript: false })
    await expect(authorizeSession(req, res, { dirName: "-Users-me-proj", fileName: "notes.txt" }, "view"))
      .resolves.toEqual({ sessionId: "notes.txt", filePath: null, isRootTranscript: false })
    expect(mock.body).toBe("")
    expect(res.setHeader).not.toHaveBeenCalled()
  })

  it("authorizes a stream only before its headers", async () => {
    const { res } = createMiddlewareRes()
    await expect(authorizeStreamSession(req, res, { sessionId: SESSION })).resolves.toEqual({ sessionId: SESSION, filePath: null, isRootTranscript: true })
    const sent = { headersSent: true } as ServerResponse
    expect(() => authorizeStreamSession(req, sent, { sessionId: SESSION })).toThrow("before its headers are sent")
  })

  it("shows every item unchanged, whatever the scope", async () => {
    const items = [{ sessionId: "a" }, { sessionId: "b" }]
    const visible = await filterVisible(req, items, (item) => item, "mine")
    expect(visible).toEqual(items)
    expect(visible).not.toBe(items)
    const check = visibilityFor(req, "shared")
    expect(check.everything).toBe(true)
    expect(check.nothing).toBe(false)
    const session = await check("a")
    expect(session).not.toBe("hidden")
    const item = { id: 1 }
    if (session !== "hidden") await expect(session.annotate(item)).resolves.toBe(item)
    expect(parseScope(req, "unassigned")).toBe("all")
  })

  it("records nothing and owns nothing", async () => {
    const session = { sessionId: SESSION, dirName: "-Users-me-proj" }
    reportSessionEvent(req, "session.stop", session)
    reportAuthEvent(req, "auth.logout")
    recordSessionOwner(req, SESSION, "claude")
    markDecided(req)
    await expect(removeSessionAccess(SESSION)).resolves.toBeUndefined()
  })

  it("passes every request through authorization", () => {
    const next = vi.fn()
    editionAuthz(req, createMiddlewareRes().res, next)
    expect(next).toHaveBeenCalledOnce()
  })

  it("answers /api/me as the one trusted owner", () => {
    expect(editionModule().me(req)).toEqual({
      authenticated: true,
      edition: "personal",
      user: null,
      capabilities: ALL_CAPABILITIES,
    })
    expect(editionModule().setupRequired()).toBe(false)
    expect(editionModule().hubProxyRejection(req, "/api/team/users", "GET")).toBeNull()
    expect(editionModule().bootNotices({ envPasswordSet: true, host: "0.0.0.0", port: 1, interfaces: {} })).toEqual([])
  })

  it("registers no routes of its own", () => {
    const use = vi.fn<UseFn>()
    editionModule().registerRoutes(use)
    expect(use).not.toHaveBeenCalled()
  })

  it("keeps the network password and lets its one caller act host-wide", () => {
    expect(editionOwnsSignIn()).toBe(false)
    expect(mayActHostWide(req)).toBe(true)
  })

  it("hands every turn straight to the agent", async () => {
    const session = { sessionId: SESSION, agent: "claude" as const }
    const started = { sessionId: SESSION, dirName: "-d", fileName: `${SESSION}.jsonl`, filePath: "/f" }
    const outcome = { delivery: "started" as const }
    const runtime = { start: vi.fn(async () => started), send: vi.fn(async () => outcome) } as unknown as AgentRuntime
    const start = { dirName: "-d", cwd: "/w", message: "hi" }

    await expect(startTurn(req, 0, runtime, start)).resolves.toBe(started)
    expect(runtime.start).toHaveBeenCalledWith(start)
    await expect(sendTurn(req, runtime, SESSION, { message: "hi" }, { receivedAt: 0, route: "send-message", session }))
      .resolves.toBe(outcome)
    expect(runtime.send).toHaveBeenCalledWith(SESSION, { message: "hi" })
    await expect(handPrompt(req, { receivedAt: 0, route: "steer", session, input: "go" }, async () => 7, "steered")).resolves.toBe(7)
  })

  it("leaves a turn's settings as they came and keeps 200 notifications, written after half a second", async () => {
    const { sessionSettings, notificationRetention } = editionModule()
    const request = { model: "opus" }
    await expect(sessionSettings.settleTurn(req, { sessionId: SESSION, agent: "claude" }, request, ["model"])).resolves.toBe(request)
    const updates = { model: "opus", effort: "high" }
    expect(sessionSettings.holdLiveUpdate(updates, [])).toBe(updates)
    expect(notificationRetention).toEqual({ hostEntries: 200, persistDelayMs: 500 })
  })
})

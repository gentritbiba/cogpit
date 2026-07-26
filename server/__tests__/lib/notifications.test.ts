// @vitest-environment node
import { describe, it, expect } from "vitest"
import { isNotifyMessage, isViewingSession, sessionPath } from "../../../shared/notifications"

const CLAUDE_NAV = { dirName: "-Users-me-proj", sessionId: "abc-123" }
const CODEX_NAV = { dirName: "codex__L1VzZXJzL21l", sessionId: "019f9931-8d56-7431-85e0-ea2454609294" }

describe("isNotifyMessage", () => {
  it("accepts a well-formed message", () => {
    expect(isNotifyMessage({ type: "notify", title: "t", body: "b", nav: CLAUDE_NAV })).toBe(true)
  })

  it.each([
    ["null", null],
    ["a string", "notify"],
    ["a wrong type tag", { type: "ready", title: "t", body: "b", nav: CLAUDE_NAV }],
    ["a missing body", { type: "notify", title: "t", nav: CLAUDE_NAV }],
    ["a non-string title", { type: "notify", title: 7, body: "b", nav: CLAUDE_NAV }],
    ["a missing nav", { type: "notify", title: "t", body: "b" }],
  ])("rejects %s", (_label, message) => {
    expect(isNotifyMessage(message)).toBe(false)
  })

  it("rejects the worker's startup messages, which share the channel", () => {
    expect(isNotifyMessage({ type: "ready", port: 19384 })).toBe(false)
    expect(isNotifyMessage({ type: "error", error: "boom" })).toBe(false)
  })
})

describe("sessionPath", () => {
  it("builds the two-segment SPA path", () => {
    expect(sessionPath(CLAUDE_NAV)).toBe("/-Users-me-proj/abc-123")
  })

  it("percent-encodes a Codex rollout path so it stays one segment", () => {
    const path = sessionPath({ dirName: "codex__abc", sessionId: "2026/07/25/rollout-x" })
    expect(path).toBe("/codex__abc/2026%2F07%2F25%2Frollout-x")
    expect(path?.split("/")).toHaveLength(3)
  })

  it("returns null when either half of the link is missing", () => {
    expect(sessionPath({ dirName: "-Users-me-proj", sessionId: null })).toBeNull()
    expect(sessionPath({ dirName: null, sessionId: "abc-123" })).toBeNull()
  })
})

describe("isViewingSession", () => {
  it("matches the session currently open", () => {
    expect(isViewingSession("http://localhost:19384/-Users-me-proj/abc-123", CLAUDE_NAV)).toBe(true)
  })

  it("does not match a different session in the same project", () => {
    expect(isViewingSession("http://localhost:19384/-Users-me-proj/other-999", CLAUDE_NAV)).toBe(false)
  })

  it("does not match the same session id under a different project", () => {
    expect(isViewingSession("http://localhost:19384/-Users-other-proj/abc-123", CLAUDE_NAV)).toBe(false)
  })

  it("does not match the project list or home", () => {
    expect(isViewingSession("http://localhost:19384/-Users-me-proj", CLAUDE_NAV)).toBe(false)
    expect(isViewingSession("http://localhost:19384/", CLAUDE_NAV)).toBe(false)
  })

  it("matches through the /d/{deviceId} remote-device prefix", () => {
    expect(isViewingSession("http://localhost:19384/d/dev1/-Users-me-proj/abc-123", CLAUDE_NAV)).toBe(true)
  })

  it("matches a percent-encoded session segment", () => {
    expect(isViewingSession("http://localhost:19384/codex__abc/2026%2F07%2F25%2Frollout-x", {
      dirName: "codex__abc",
      sessionId: "2026/07/25/rollout-x",
    })).toBe(true)
  })

  it("matches a Codex thread id against the dated rollout path the session list uses", () => {
    const url = `http://localhost:19384/${CODEX_NAV.dirName}/2026%2F07%2F25%2Frollout-2026-07-25T14-13-09-${CODEX_NAV.sessionId}`
    expect(isViewingSession(url, CODEX_NAV)).toBe(true)
  })

  it("returns false for an unparseable url or an incomplete nav", () => {
    expect(isViewingSession("not a url", CLAUDE_NAV)).toBe(false)
    expect(isViewingSession("http://localhost:19384/-Users-me-proj/abc-123", { dirName: null, sessionId: null }))
      .toBe(false)
  })
})

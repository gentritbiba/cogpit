// @vitest-environment node
import { describe, it, expect } from "vitest"
import { sessionPath } from "../../../shared/notifications"

const CLAUDE_NAV = { dirName: "-Users-me-proj", sessionId: "abc-123" }

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

import { describe, expect, it } from "vitest"
import { isExternalCopilotSession } from "../sessionControl"

describe("isExternalCopilotSession", () => {
  it("marks an untracked Copilot process as external", () => {
    expect(isExternalCopilotSession("copilot", { managed: false })).toBe(true)
  })

  it("keeps Cogpit-owned Copilot sessions controllable", () => {
    expect(isExternalCopilotSession("copilot", { managed: true })).toBe(false)
    expect(isExternalCopilotSession("copilot", undefined)).toBe(false)
  })

  it("does not change Claude or Codex process controls", () => {
    expect(isExternalCopilotSession("claude", { managed: false })).toBe(false)
    expect(isExternalCopilotSession("codex", { managed: false })).toBe(false)
  })
})

import { describe, expect, it } from "vitest"
import { isExternallyDrivenSession } from "../sessionControl"

describe("isExternallyDrivenSession", () => {
  it("marks an untracked Copilot process as external", () => {
    expect(isExternallyDrivenSession("copilot", { managed: false })).toBe(true)
  })

  it("keeps Cogpit-owned Copilot sessions controllable", () => {
    expect(isExternallyDrivenSession("copilot", { managed: true })).toBe(false)
    expect(isExternallyDrivenSession("copilot", undefined)).toBe(false)
  })

  it("does not change Claude or Codex process controls", () => {
    expect(isExternallyDrivenSession("claude", { managed: false })).toBe(false)
    expect(isExternallyDrivenSession("codex", { managed: false })).toBe(false)
  })
})

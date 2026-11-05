import { describe, it, expect } from "vitest"
import { defaultPermissions } from "../permissions"

describe("defaultPermissions", () => {
  it("starts a new install in the ask-first mode every agent has", () => {
    expect(defaultPermissions(true).mode).toBe("default")
  })

  it("keeps an earlier install in full access", () => {
    expect(defaultPermissions(false).mode).toBe("bypassPermissions")
  })

  it("has empty allowedTools and disallowedTools", () => {
    for (const fresh of [true, false]) {
      expect(defaultPermissions(fresh).allowedTools).toEqual([])
      expect(defaultPermissions(fresh).disallowedTools).toEqual([])
    }
  })
})

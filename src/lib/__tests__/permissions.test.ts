import { describe, it, expect } from "vitest"
import { DEFAULT_PERMISSIONS } from "../permissions"

describe("DEFAULT_PERMISSIONS", () => {
  it("defaults to full access", () => {
    expect(DEFAULT_PERMISSIONS.mode).toBe("bypassPermissions")
  })

  it("has empty allowedTools and disallowedTools", () => {
    expect(DEFAULT_PERMISSIONS.allowedTools).toEqual([])
    expect(DEFAULT_PERMISSIONS.disallowedTools).toEqual([])
  })
})

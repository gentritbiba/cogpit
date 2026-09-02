import { describe, it, expect } from "vitest"
import { DEFAULT_PERMISSIONS, KNOWN_TOOLS } from "../permissions"

describe("DEFAULT_PERMISSIONS", () => {
  it("defaults to full access", () => {
    expect(DEFAULT_PERMISSIONS.mode).toBe("bypassPermissions")
  })

  it("has empty allowedTools and disallowedTools", () => {
    expect(DEFAULT_PERMISSIONS.allowedTools).toEqual([])
    expect(DEFAULT_PERMISSIONS.disallowedTools).toEqual([])
  })
})

describe("KNOWN_TOOLS", () => {
  it("contains expected tools", () => {
    expect(KNOWN_TOOLS).toContain("Bash")
    expect(KNOWN_TOOLS).toContain("Read")
    expect(KNOWN_TOOLS).toContain("Write")
    expect(KNOWN_TOOLS).toContain("Edit")
    expect(KNOWN_TOOLS).toContain("Task")
  })

  it("is a readonly array", () => {
    expect(Array.isArray(KNOWN_TOOLS)).toBe(true)
    expect(KNOWN_TOOLS.length).toBeGreaterThan(0)
  })
})

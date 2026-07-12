import { describe, it, expect } from "vitest"
import {
  buildPermissionArgs,
  DEFAULT_PERMISSIONS,
  KNOWN_TOOLS,
  type PermissionsConfig,
} from "../permissions"

describe("DEFAULT_PERMISSIONS", () => {
  it("defaults to the approval-aware workspace mode", () => {
    expect(DEFAULT_PERMISSIONS.mode).toBe("default")
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

describe("buildPermissionArgs", () => {
  it("returns bypass for bypassPermissions mode", () => {
    const config: PermissionsConfig = {
      mode: "bypassPermissions",
      allowedTools: [],
      disallowedTools: [],
    }
    expect(buildPermissionArgs(config)).toEqual(["--dangerously-skip-permissions"])
  })

  it("returns --permission-mode default for default mode", () => {
    const config: PermissionsConfig = {
      mode: "default",
      allowedTools: [],
      disallowedTools: [],
    }
    expect(buildPermissionArgs(config)).toEqual(["--permission-mode", "default"])
  })

  it("includes allowedTools and disallowedTools", () => {
    const config: PermissionsConfig = {
      mode: "plan",
      allowedTools: ["Bash", "Read"],
      disallowedTools: ["Write"],
    }
    expect(buildPermissionArgs(config)).toEqual([
      "--permission-mode", "plan",
      "--allowedTools", "Bash",
      "--allowedTools", "Read",
      "--disallowedTools", "Write",
    ])
  })

  it("returns empty for unmapped mode with no tools", () => {
    const config: PermissionsConfig = {
      mode: "delegate",
      allowedTools: [],
      disallowedTools: [],
    }
    expect(buildPermissionArgs(config)).toEqual([])
  })
})

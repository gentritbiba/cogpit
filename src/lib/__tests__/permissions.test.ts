import { describe, it, expect } from "vitest"
import {
  buildPermissionArgs,
  DEFAULT_PERMISSIONS,
  KNOWN_TOOLS,
  type PermissionsConfig,
} from "../permissions"

describe("DEFAULT_PERMISSIONS", () => {
  it("has bypassPermissions as default mode", () => {
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

describe("buildPermissionArgs", () => {
  it("returns --dangerously-skip-permissions for bypassPermissions mode", () => {
    const config: PermissionsConfig = {
      mode: "bypassPermissions",
      allowedTools: [],
      disallowedTools: [],
    }
    expect(buildPermissionArgs(config)).toEqual(["--dangerously-skip-permissions"])
  })

  it("returns --dangerously-skip-permissions even with tools specified", () => {
    const config: PermissionsConfig = {
      mode: "bypassPermissions",
      allowedTools: ["Bash"],
      disallowedTools: ["Write"],
    }
    expect(buildPermissionArgs(config)).toEqual(["--dangerously-skip-permissions"])
  })

  it("ignores non-bypass modes and still returns YOLO args", () => {
    const config: PermissionsConfig = {
      mode: "default",
      allowedTools: [],
      disallowedTools: [],
    }
    expect(buildPermissionArgs(config)).toEqual(["--dangerously-skip-permissions"])
  })

  it("ignores plan mode and still returns YOLO args", () => {
    const config: PermissionsConfig = {
      mode: "plan",
      allowedTools: [],
      disallowedTools: [],
    }
    expect(buildPermissionArgs(config)).toEqual(["--dangerously-skip-permissions"])
  })

  it("ignores allowedTools", () => {
    const config: PermissionsConfig = {
      mode: "default",
      allowedTools: ["Bash", "Read"],
      disallowedTools: [],
    }
    expect(buildPermissionArgs(config)).toEqual(["--dangerously-skip-permissions"])
  })

  it("ignores disallowedTools", () => {
    const config: PermissionsConfig = {
      mode: "acceptEdits",
      allowedTools: [],
      disallowedTools: ["Write", "Edit"],
    }
    expect(buildPermissionArgs(config)).toEqual(["--dangerously-skip-permissions"])
  })

  it("ignores mixed allow and deny lists", () => {
    const config: PermissionsConfig = {
      mode: "dontAsk",
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
    }
    expect(buildPermissionArgs(config)).toEqual(["--dangerously-skip-permissions"])
  })

  it("ignores delegate mode", () => {
    const config: PermissionsConfig = {
      mode: "delegate",
      allowedTools: [],
      disallowedTools: [],
    }
    expect(buildPermissionArgs(config)).toEqual(["--dangerously-skip-permissions"])
  })

  it("ignores multiple allow and deny entries", () => {
    const config: PermissionsConfig = {
      mode: "default",
      allowedTools: ["Read", "Glob", "Grep"],
      disallowedTools: ["Bash", "Write", "Edit"],
    }
    expect(buildPermissionArgs(config)).toEqual(["--dangerously-skip-permissions"])
  })

  it("ignores output ordering because extra permission args are disabled", () => {
    const config: PermissionsConfig = {
      mode: "acceptEdits",
      allowedTools: ["Task"],
      disallowedTools: ["Bash"],
    }
    expect(buildPermissionArgs(config)).toEqual(["--dangerously-skip-permissions"])
  })
})

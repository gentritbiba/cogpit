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
    // bypassPermissions short-circuits; tools are ignored
    expect(buildPermissionArgs(config)).toEqual(["--dangerously-skip-permissions"])
  })

  it("returns permission-mode flag for default mode", () => {
    const config: PermissionsConfig = {
      mode: "default",
      allowedTools: [],
      disallowedTools: [],
    }
    expect(buildPermissionArgs(config)).toEqual(["--permission-mode", "default"])
  })

  it("returns permission-mode flag for plan mode", () => {
    const config: PermissionsConfig = {
      mode: "plan",
      allowedTools: [],
      disallowedTools: [],
    }
    expect(buildPermissionArgs(config)).toEqual(["--permission-mode", "plan"])
  })

  it("includes allowedTools args", () => {
    const config: PermissionsConfig = {
      mode: "default",
      allowedTools: ["Bash", "Read"],
      disallowedTools: [],
    }
    const args = buildPermissionArgs(config)
    expect(args).toEqual([
      "--permission-mode", "default",
      "--allowedTools", "Bash",
      "--allowedTools", "Read",
    ])
  })

  it("includes disallowedTools args", () => {
    const config: PermissionsConfig = {
      mode: "acceptEdits",
      allowedTools: [],
      disallowedTools: ["Write", "Edit"],
    }
    const args = buildPermissionArgs(config)
    expect(args).toEqual([
      "--permission-mode", "acceptEdits",
      "--disallowedTools", "Write",
      "--disallowedTools", "Edit",
    ])
  })

  it("includes both allowedTools and disallowedTools", () => {
    const config: PermissionsConfig = {
      mode: "dontAsk",
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
    }
    const args = buildPermissionArgs(config)
    expect(args).toEqual([
      "--permission-mode", "dontAsk",
      "--allowedTools", "Read",
      "--disallowedTools", "Bash",
    ])
  })

  it("handles delegate mode", () => {
    const config: PermissionsConfig = {
      mode: "delegate",
      allowedTools: [],
      disallowedTools: [],
    }
    expect(buildPermissionArgs(config)).toEqual(["--permission-mode", "delegate"])
  })

  it("handles multiple allowed AND multiple disallowed tools simultaneously", () => {
    const config: PermissionsConfig = {
      mode: "default",
      allowedTools: ["Read", "Glob", "Grep"],
      disallowedTools: ["Bash", "Write", "Edit"],
    }
    const args = buildPermissionArgs(config)
    expect(args).toEqual([
      "--permission-mode", "default",
      "--allowedTools", "Read",
      "--allowedTools", "Glob",
      "--allowedTools", "Grep",
      "--disallowedTools", "Bash",
      "--disallowedTools", "Write",
      "--disallowedTools", "Edit",
    ])
  })

  it("produces allowed before disallowed in output order", () => {
    const config: PermissionsConfig = {
      mode: "acceptEdits",
      allowedTools: ["Task"],
      disallowedTools: ["Bash"],
    }
    const args = buildPermissionArgs(config)
    const allowedIdx = args.indexOf("--allowedTools")
    const disallowedIdx = args.indexOf("--disallowedTools")
    expect(allowedIdx).toBeLessThan(disallowedIdx)
  })
})

import { describe, expect, it } from "vitest"

import {
  findExecutableOnPath,
  hasExecutableExtension,
  nativeBinaryName,
  resolveAgentCommand,
  type ResolveEnvironment,
} from "../../lib/binaryResolver"

/** A fake Windows box: `PATH`, `PATHEXT` and the set of files that exist. */
function windows(files: string[], overrides: Partial<ResolveEnvironment> = {}): ResolveEnvironment {
  const present = new Set(files)
  return {
    platform: "win32",
    env: {
      PATH: "C:\\Windows\\system32;C:\\Users\\me\\AppData\\Roaming\\npm",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      COMSPEC: "C:\\Windows\\system32\\cmd.exe",
    },
    isExecutable: (candidate) => present.has(candidate),
    ...overrides,
  }
}

const NPM_DIR = "C:\\Users\\me\\AppData\\Roaming\\npm"

describe("findExecutableOnPath", () => {
  it("walks PATH with an executable-bit probe outside Windows", () => {
    const found = findExecutableOnPath("claude", {
      platform: "darwin",
      env: { PATH: "/usr/bin:/opt/homebrew/bin" },
      isExecutable: (candidate) => candidate === "/opt/homebrew/bin/claude",
    })
    expect(found).toBe("/opt/homebrew/bin/claude")
  })

  it("finds the npm .cmd shim that CreateProcess would never see", () => {
    const found = findExecutableOnPath("claude", windows([`${NPM_DIR}\\claude.cmd`]))
    expect(found).toBe(`${NPM_DIR}\\claude.cmd`)
  })

  it("prefers a real executable over a shim in the same directory", () => {
    const found = findExecutableOnPath("claude", windows([
      `${NPM_DIR}\\claude.cmd`,
      `${NPM_DIR}\\claude.exe`,
    ]))
    expect(found).toBe(`${NPM_DIR}\\claude.exe`)
  })

  it("honours PATH order ahead of PATHEXT order", () => {
    const found = findExecutableOnPath("codex", windows([
      "C:\\Windows\\system32\\codex.cmd",
      `${NPM_DIR}\\codex.exe`,
    ]))
    expect(found).toBe("C:\\Windows\\system32\\codex.cmd")
  })

  it("accepts an extensionless file as a cmd.exe target", () => {
    const found = findExecutableOnPath("codex", windows([`${NPM_DIR}\\codex`]))
    expect(found).toBe(`${NPM_DIR}\\codex`)
  })

  it("skips shims when only a directly spawnable binary will do", () => {
    const shimOnly = windows([`${NPM_DIR}\\claude.cmd`, `${NPM_DIR}\\claude`])
    expect(findExecutableOnPath("claude", { ...shimOnly, directOnly: true })).toBeUndefined()
  })

  it("returns a directly spawnable binary when one exists", () => {
    const env = windows([`${NPM_DIR}\\claude.cmd`, `${NPM_DIR}\\claude.exe`])
    expect(findExecutableOnPath("claude", { ...env, directOnly: true }))
      .toBe(`${NPM_DIR}\\claude.exe`)
  })

  it("uses a name that already carries a known extension verbatim", () => {
    const found = findExecutableOnPath("claude.exe", windows([`${NPM_DIR}\\claude.exe`]))
    expect(found).toBe(`${NPM_DIR}\\claude.exe`)
  })

  it("falls back to the default PATHEXT when the variable is unset", () => {
    const env = windows([`${NPM_DIR}\\claude.cmd`])
    expect(findExecutableOnPath("claude", { ...env, env: { PATH: NPM_DIR } }))
      .toBe(`${NPM_DIR}\\claude.cmd`)
  })

  it("returns undefined when nothing on PATH matches", () => {
    expect(findExecutableOnPath("claude", windows([]))).toBeUndefined()
  })
})

describe("resolveAgentCommand", () => {
  it("spawns the bare name outside Windows", () => {
    const cli = resolveAgentCommand("codex", ["exec", "--json"], { platform: "darwin" })
    expect(cli).toEqual({ command: "codex", args: ["exec", "--json"], spawnOptions: {} })
  })

  it("spawns a Windows .exe directly", () => {
    const cli = resolveAgentCommand("claude", ["mcp", "list"], windows([`${NPM_DIR}\\claude.exe`]))
    expect(cli).toEqual({
      command: `${NPM_DIR}\\claude.exe`,
      args: ["mcp", "list"],
      spawnOptions: {},
    })
  })

  it("routes a .cmd shim through cmd.exe with verbatim arguments", () => {
    const cli = resolveAgentCommand("claude", ["mcp", "list"], windows([`${NPM_DIR}\\claude.cmd`]))
    expect(cli.command).toBe("C:\\Windows\\system32\\cmd.exe")
    expect(cli.args).toEqual([
      "/d",
      "/s",
      "/c",
      `"${NPM_DIR}\\claude.cmd ^"mcp^" ^"list^""`,
    ])
    expect(cli.spawnOptions).toEqual({ windowsVerbatimArguments: true })
  })

  it("keeps spaces, quotes and shell metacharacters inside a message argument", () => {
    const cli = resolveAgentCommand(
      "codex",
      ["exec", 'say "hi" & echo %PATH% | more'],
      windows([`${NPM_DIR}\\codex.cmd`]),
    )
    const line = cli.args[3]
    // Every cmd.exe metacharacter is caret-escaped, so the shim forwards the
    // message as ONE argument instead of running `echo` and `more`.
    expect(line).toContain('^"say^ \\^"hi\\^"^ ^&^ echo^ ^%PATH^%^ ^|^ more^"')
    expect(line).not.toMatch(/[^^]&/)
    expect(line).not.toMatch(/[^^]\|/)
  })

  it("escapes spaces in the resolved shim path", () => {
    const shim = "C:\\Program Files\\nodejs\\codex.cmd"
    const cli = resolveAgentCommand("codex", ["exec"], windows([shim], {
      env: { PATH: "C:\\Program Files\\nodejs", PATHEXT: ".EXE;.CMD" },
    }))
    expect(cli.args[3]).toBe('"C:\\Program^ Files\\nodejs\\codex.cmd ^"exec^""')
  })

  it("uses COMSPEC when it is set", () => {
    const cli = resolveAgentCommand("codex", [], windows([`${NPM_DIR}\\codex.cmd`], {
      env: {
        PATH: NPM_DIR,
        PATHEXT: ".EXE;.CMD",
        COMSPEC: "D:\\alt\\cmd.exe",
      },
    }))
    expect(cli.command).toBe("D:\\alt\\cmd.exe")
  })

  it("wraps an explicitly configured shim path without searching PATH", () => {
    const cli = resolveAgentCommand("D:\\tools\\codex.cmd", ["exec"], windows([]))
    expect(cli.command).toBe("C:\\Windows\\system32\\cmd.exe")
    expect(cli.args[3]).toBe('"D:\\tools\\codex.cmd ^"exec^""')
  })

  it("keeps the bare name when the CLI is not installed, so callers still get ENOENT", () => {
    const cli = resolveAgentCommand("codex", ["exec"], windows([]))
    expect(cli).toEqual({ command: "codex", args: ["exec"], spawnOptions: {} })
  })
})

describe("nativeBinaryName", () => {
  it("appends .exe only on Windows", () => {
    expect(nativeBinaryName("claude", "win32")).toBe("claude.exe")
    expect(nativeBinaryName("claude", "darwin")).toBe("claude")
  })
})

describe("hasExecutableExtension", () => {
  const env = { PATHEXT: ".COM;.EXE;.BAT;.CMD" }

  it("accepts PATHEXT members regardless of case", () => {
    expect(hasExecutableExtension("runme.cmd", env)).toBe(true)
    expect(hasExecutableExtension("RunMe.CMD", env)).toBe(true)
    expect(hasExecutableExtension("tool.exe", env)).toBe(true)
  })

  it("rejects documents and extensionless files", () => {
    // The pair that mattered: on Windows fs.access(X_OK) passes for both.
    expect(hasExecutableExtension("readme.txt", env)).toBe(false)
    expect(hasExecutableExtension("runme", env)).toBe(false)
  })

  it("falls back to the default PATHEXT when unset", () => {
    expect(hasExecutableExtension("runme.bat", {})).toBe(true)
    expect(hasExecutableExtension("runme.txt", {})).toBe(false)
  })
})

// @vitest-environment node
import { describe, expect, it } from "vitest"

import {
  chooseClaudeExecutable,
  discoverClaudeExecutables,
  findNpmClaude,
  type ClaudeExecutables,
} from "../../agents/claudeExecutable"

const binName = process.platform === "win32" ? "claude.exe" : "claude"
const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
const devResolve = (id: string) => `/Users/me/app/node_modules/${id}`
const asarResolve = (id: string) =>
  `/Applications/Cogpit.app/Contents/Resources/app.asar/node_modules/${id}`
const devBin = `/Users/me/app/node_modules/${platformPkg}/${binName}`
const unpackedBin = `/Applications/Cogpit.app/Contents/Resources/app.asar.unpacked/node_modules/${platformPkg}/${binName}`
const installedBin = `/usr/local/bin/${binName}`
const npmBin = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"

const none = { findOnPath: () => undefined, findNpm: () => undefined }

describe("discoverClaudeExecutables", () => {
  it("points at the vendored binary in a dev checkout", () => {
    expect(discoverClaudeExecutables(devResolve, none)).toEqual({
      installed: undefined,
      npm: undefined,
      bundled: devBin,
    })
  })

  it("rewrites app.asar paths to app.asar.unpacked", () => {
    expect(discoverClaudeExecutables(asarResolve, none).bundled).toBe(unpackedBin)
  })

  it("rewrites app.asar paths that use Windows separators", () => {
    // Regression: the rewrite matched "/app.asar/" only, so the packaged
    // Windows app tried to spawn the CLI from inside the archive.
    const root = "C:\\Users\\me\\AppData\\Local\\Programs\\Cogpit\\resources"
    const found = discoverClaudeExecutables(
      (id) => `${root}\\app.asar\\node_modules\\${id.replace(/\//g, "\\")}`,
      none,
    )
    expect(found.bundled).toBe(
      `${root}\\app.asar.unpacked\\node_modules\\@anthropic-ai\\${platformPkg.split("/")[1]}\\${binName}`,
    )
  })

  it("has no bundled binary when the platform package cannot be resolved", () => {
    const found = discoverClaudeExecutables(() => {
      throw new Error("Cannot find module")
    }, none)
    expect(found.bundled).toBeUndefined()
  })

  it("records the PATH hit and the npm shim target separately", () => {
    const found = discoverClaudeExecutables(devResolve, {
      findOnPath: () => installedBin,
      findNpm: () => npmBin,
    })
    expect(found.installed).toBe(installedBin)
    expect(found.npm).toBe(npmBin)
  })
})

describe("chooseClaudeExecutable", () => {
  const versions = (table: Record<string, number[] | undefined>) =>
    (bin: string) => table[bin]
  const found = (overrides: Partial<ClaudeExecutables>): ClaudeExecutables => ({
    installed: undefined,
    npm: undefined,
    bundled: devBin,
    ...overrides,
  })

  describe("auto", () => {
    const auto = { source: "auto" as const }

    it("uses the bundled binary when nothing is installed", () => {
      expect(chooseClaudeExecutable(auto, found({}), () => undefined)).toEqual({
        source: "bundled",
        path: devBin,
      })
    })

    it("is undefined when neither an install nor a bundled copy exists", () => {
      expect(
        chooseClaudeExecutable(auto, found({ bundled: undefined }), () => undefined),
      ).toBeUndefined()
    })

    it("prefers the installed CLI when it is newer than the bundled binary", () => {
      const result = chooseClaudeExecutable(
        auto,
        found({ installed: installedBin }),
        versions({ [installedBin]: [2, 1, 220], [devBin]: [2, 1, 215] }),
      )
      expect(result).toEqual({ source: "path", path: installedBin })
    })

    it("prefers the installed CLI when it matches the bundled version", () => {
      const result = chooseClaudeExecutable(auto, found({ installed: installedBin }), () => [2, 1, 215])
      expect(result).toEqual({ source: "path", path: installedBin })
    })

    it("falls back to the bundled binary when the installed CLI is older", () => {
      const result = chooseClaudeExecutable(
        auto,
        found({ installed: installedBin }),
        versions({ [installedBin]: [2, 0, 9], [devBin]: [2, 1, 215] }),
      )
      expect(result).toEqual({ source: "bundled", path: devBin })
    })

    it("ignores an installed CLI that will not report a version", () => {
      const result = chooseClaudeExecutable(
        auto,
        found({ installed: installedBin }),
        versions({ [devBin]: [2, 1, 215] }),
      )
      expect(result).toEqual({ source: "bundled", path: devBin })
    })

    it("uses an installed CLI with an unreadable version when no bundled binary exists", () => {
      const result = chooseClaudeExecutable(
        auto,
        found({ installed: installedBin, bundled: undefined }),
        () => undefined,
      )
      expect(result).toEqual({ source: "path", path: installedBin })
    })

    it("uses the installed CLI when the bundled binary has no readable version", () => {
      const result = chooseClaudeExecutable(
        auto,
        found({ installed: installedBin }),
        versions({ [installedBin]: [2, 1, 220] }),
      )
      expect(result).toEqual({ source: "path", path: installedBin })
    })

    it("never follows the npm shim on its own — that is the opt-in", () => {
      const result = chooseClaudeExecutable(
        auto,
        found({ npm: npmBin }),
        versions({ [npmBin]: [2, 1, 258], [devBin]: [2, 1, 245] }),
      )
      expect(result).toEqual({ source: "bundled", path: devBin })
    })
  })

  it("npm follows the shim regardless of version", () => {
    const result = chooseClaudeExecutable(
      { source: "npm" },
      found({ installed: installedBin, npm: npmBin }),
      versions({ [npmBin]: [2, 0, 1], [devBin]: [2, 1, 245] }),
    )
    expect(result).toEqual({ source: "npm", path: npmBin })
  })

  it("an explicit source with nothing behind it resolves to nothing", () => {
    expect(chooseClaudeExecutable({ source: "npm" }, found({}), () => undefined)).toBeUndefined()
    expect(chooseClaudeExecutable({ source: "path" }, found({}), () => undefined)).toBeUndefined()
    expect(
      chooseClaudeExecutable({ source: "bundled" }, found({ bundled: undefined }), () => undefined),
    ).toBeUndefined()
  })

  it("bundled and path pick their binary without comparing versions", () => {
    const table = versions({ [installedBin]: [2, 0, 1], [devBin]: [2, 1, 245] })
    expect(chooseClaudeExecutable({ source: "bundled" }, found({ installed: installedBin }), table))
      .toEqual({ source: "bundled", path: devBin })
    expect(chooseClaudeExecutable({ source: "path" }, found({ installed: installedBin }), table))
      .toEqual({ source: "path", path: installedBin })
  })

  it("custom hands back the user's path untouched", () => {
    expect(
      chooseClaudeExecutable({ source: "custom", path: "/opt/claude/claude" }, found({}), () => undefined),
    ).toEqual({ source: "custom", path: "/opt/claude/claude" })
  })
})

describe("findNpmClaude", () => {
  const files = new Map<string, string>()
  const fs = {
    isFile: (path: string) => files.has(path),
    readFile: (path: string) => files.get(path),
  }

  it("follows a Windows .cmd shim to the package's native binary", () => {
    files.clear()
    const prefix = "C:\\Users\\me\\AppData\\Roaming\\npm"
    files.set(`${prefix}\\claude.cmd`, "@ECHO off ...")
    files.set(
      `${prefix}\\node_modules\\@anthropic-ai\\claude-code\\package.json`,
      JSON.stringify({ bin: { claude: "bin/claude.exe" } }),
    )
    files.set(`${prefix}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`, "MZ")

    expect(findNpmClaude({ platform: "win32", env: { PATH: prefix }, ...fs })).toBe(
      `${prefix}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`,
    )
  })

  it("refuses a target cmd.exe would be needed for", () => {
    files.clear()
    const prefix = "C:\\npm"
    files.set(`${prefix}\\claude.cmd`, "")
    files.set(
      `${prefix}\\node_modules\\@anthropic-ai\\claude-code\\package.json`,
      JSON.stringify({ bin: { claude: "cli.js" } }),
    )
    files.set(`${prefix}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`, "")
    expect(findNpmClaude({ platform: "win32", env: { PATH: prefix }, ...fs })).toBeUndefined()
  })

  it("follows the posix prefix layout through ../lib/node_modules", () => {
    files.clear()
    files.set("/usr/local/bin/claude", "")
    files.set(
      "/usr/local/lib/node_modules/@anthropic-ai/claude-code/package.json",
      JSON.stringify({ bin: "bin/claude" }),
    )
    files.set("/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude", "")
    expect(findNpmClaude({ platform: "linux", env: { PATH: "/usr/local/bin" }, ...fs })).toBe(
      "/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude",
    )
  })

  it("is undefined when no global package sits behind the shim", () => {
    files.clear()
    files.set("/Users/me/.local/bin/claude", "")
    expect(
      findNpmClaude({ platform: "darwin", env: { PATH: "/Users/me/.local/bin" }, ...fs }),
    ).toBeUndefined()
  })
})

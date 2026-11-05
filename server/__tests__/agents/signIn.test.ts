// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderInstance } from "../../../shared/contracts/orchestration"

const mocks = vi.hoisted(() => ({
  instances: new Map<string, ProviderInstance>(),
  spawned: vi.fn<(kind: string) => { path: string; source: "path" | "npm" | "bundled" | "custom" } | null>(),
}))
vi.mock("../../agents/executables", () => ({ spawnedExecutableFor: mocks.spawned }))
vi.mock("../../agents/instanceConfigurations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/instanceConfigurations")>()),
  providerInstance: (id: string) => {
    const found = mocks.instances.get(id)
    if (!found) throw new Error("Provider instance not found")
    return found
  },
}))

import { agentSignInCommand, agentSignInLaunch, agentSignInTerminalCommand, providerSetupCommand } from "../../agents/signIn"

const BUNDLED = "/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"
let root = ""

function onPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { ...original, value: platform })
  try { return fn() } finally { Object.defineProperty(process, "platform", original) }
}

function instance(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  const value: ProviderInstance = { id: "work", agent: "claude", label: "Work", homeDir: join(root, "work"), createdAt: 0, ...overrides }
  mocks.instances.set(value.id, value)
  return value
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cogpit-sign-in-"))
  vi.stubEnv("COGPIT_ORCHESTRATION_ROOT", root)
  mocks.instances.clear()
  mocks.spawned.mockImplementation((kind) => (kind === "claude" ? { path: BUNDLED, source: "bundled" } : null))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe("agentSignInLaunch", () => {
  it("signs the default account in with the binary Cogpit runs, even the bundled one", () => {
    expect(onPlatform("darwin", () => agentSignInLaunch("claude"))).toEqual({
      command: BUNDLED, args: ["auth", "login"], verbatimArgs: false, env: {},
    })
    expect(onPlatform("linux", () => agentSignInLaunch("codex"))).toMatchObject({ command: "codex", args: ["login"] })
  })

  it("signs an account instance in with its own executable and home, from the worker's env builder", () => {
    const work = instance({ executable: "/opt/claude-work/claude" })
    const launch = onPlatform("darwin", () => agentSignInLaunch("claude", "work"))!
    const user = join(work.homeDir, "user")
    expect(launch.command).toBe("/opt/claude-work/claude")
    expect(launch.env).toEqual({
      HOME: user,
      XDG_CONFIG_HOME: join(user, ".config"),
      XDG_CACHE_HOME: join(user, ".cache"),
      XDG_DATA_HOME: join(user, ".local/share"),
      CLAUDE_CONFIG_DIR: work.homeDir,
    })
  })

  it("launches a Windows npm shim through cmd.exe, as the runtimes do", () => {
    mocks.spawned.mockReturnValue({ path: "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd", source: "path" })
    vi.stubEnv("COMSPEC", "C:\\Windows\\system32\\cmd.exe")
    const launch = onPlatform("win32", () => agentSignInLaunch("codex"))!
    expect(launch.command).toBe("C:\\Windows\\system32\\cmd.exe")
    expect(launch.verbatimArgs).toBe(true)
    expect(launch.args.slice(0, 3)).toEqual(["/d", "/s", "/c"])
    expect(launch.args[3]).toContain("codex.cmd")
    expect(launch.args[3]).toContain("login")
  })

  it("refuses an instance that belongs to another agent, and an agent with no sign-in", () => {
    instance({ id: "cx", agent: "codex" })
    expect(() => agentSignInLaunch("claude", "cx")).toThrow("different agent")
    expect(agentSignInLaunch("acp")).toBeNull()
  })
})

describe("sign-in commands to copy", () => {
  it("spells the default account's command with the binary Cogpit runs", () => {
    expect(onPlatform("darwin", () => agentSignInCommand("claude"))).toBe(`${BUNDLED} auth login`)
    mocks.spawned.mockReturnValue({ path: "/Users/me/Application Support/claude", source: "custom" })
    expect(onPlatform("darwin", () => agentSignInCommand("claude"))).toBe("'/Users/me/Application Support/claude' auth login")
  })

  it("points an instance's command at its own home", () => {
    const work = instance()
    expect(onPlatform("darwin", () => agentSignInCommand("claude", "work")))
      .toBe(`env HOME='${join(work.homeDir, "user")}' XDG_CONFIG_HOME='${join(work.homeDir, "user", ".config")}' XDG_CACHE_HOME='${join(work.homeDir, "user", ".cache")}' XDG_DATA_HOME='${join(work.homeDir, "user", ".local/share")}' CLAUDE_CONFIG_DIR='${work.homeDir}' ${BUNDLED} auth login`)
    expect(onPlatform("win32", () => agentSignInCommand("claude", "work"))).toMatch(/^\$env:HOME='.+'; .+; & '.+claude' auth login$/)
  })

  it("quotes an apostrophe the way each shell needs, in the executable and in instance paths", () => {
    mocks.spawned.mockReturnValue({ path: "C:\\Users\\O'Brien\\AppData\\Roaming\\npm\\codex.cmd", source: "custom" })
    expect(onPlatform("win32", () => agentSignInCommand("codex")))
      .toBe("& 'C:\\Users\\O''Brien\\AppData\\Roaming\\npm\\codex.cmd' login")
    mocks.spawned.mockReturnValue({ path: "/Users/O'Brien/bin/codex", source: "custom" })
    expect(onPlatform("darwin", () => agentSignInCommand("codex"))).toBe("'/Users/O'\\''Brien/bin/codex' login")

    const home = join(root, "O'Brien")
    instance({ id: "obrien", homeDir: home, executable: join(home, "claude") })
    const user = join(home, "user")
    const powershell = onPlatform("win32", () => agentSignInCommand("claude", "obrien"))!
    expect(powershell).toContain(`$env:HOME='${user.replace(/'/g, "''")}'`)
    expect(powershell).toContain(`$env:CLAUDE_CONFIG_DIR='${home.replace(/'/g, "''")}'`)
    expect(powershell.endsWith(`& '${join(home, "claude").replace(/'/g, "''")}' auth login`)).toBe(true)
    expect(powershell).not.toContain("'\\''")
    const posix = onPlatform("darwin", () => agentSignInCommand("claude", "obrien"))!
    expect(posix).toContain(`HOME='${user.replace(/'/g, "'\\''")}'`)
    expect(posix).toContain(`CLAUDE_CONFIG_DIR='${home.replace(/'/g, "'\\''")}'`)
    expect(posix.endsWith(`'${join(home, "claude").replace(/'/g, "'\\''")}' auth login`)).toBe(true)
  })

  it("names a binary found on PATH the short way, and gives the agent check the same command", () => {
    mocks.spawned.mockReturnValue({ path: "/usr/local/bin/claude", source: "path" })
    expect(onPlatform("darwin", () => agentSignInCommand("claude"))).toBe("claude auth login")
    expect(onPlatform("win32", () => agentSignInCommand("claude"))).toBe("claude auth login")

    for (const binary of [{ path: "/usr/local/bin/claude", source: "path" as const }, { path: BUNDLED, source: "bundled" as const }]) {
      mocks.spawned.mockReturnValue(binary)
      expect(agentSignInTerminalCommand("claude", binary, "darwin")).toEqual({
        executable: binary.path,
        args: ["auth", "login"],
        command: onPlatform("darwin", () => agentSignInCommand("claude")),
      })
    }
    expect(agentSignInTerminalCommand("acp", { path: "/opt/acp", source: "custom" }, "darwin")).toBeNull()
  })

  it("leaves an ACP instance's login for the administrator to fill in", () => {
    const acp = instance({ id: "acp1", agent: "acp", executable: "/opt/acp" })
    expect(onPlatform("darwin", () => providerSetupCommand(acp))).toMatch(/^env HOME='.+' <provider-login-command>$/)
  })
})

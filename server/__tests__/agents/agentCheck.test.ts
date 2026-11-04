// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../agents/executables", () => ({
  launchableExecutableFor: vi.fn(),
  rediscoverExecutables: vi.fn(),
}))
vi.mock("../../lib/cliProcess", () => ({
  probeCliVersion: vi.fn(),
  runCli: vi.fn(),
}))

import { checkAgents } from "../../agents/agentCheck"
import { launchableExecutableFor, rediscoverExecutables } from "../../agents/executables"
import { probeCliVersion, runCli } from "../../lib/cliProcess"
import { descriptorFor, installableDescriptors } from "../../../shared/session/agent-descriptors"
import type { AgentKind } from "../../../shared/session/types"
import type { ActiveExecutable } from "../../../shared/contracts/agentExecutable"

const mockedLaunchable = vi.mocked(launchableExecutableFor)
const mockedRunCli = vi.mocked(runCli)
const mockedProbeVersion = vi.mocked(probeCliVersion)

type Binaries = Partial<Record<AgentKind, { path: string; source: ActiveExecutable["source"] }>>

function machine(binaries: Binaries, status: Partial<Record<string, { code: number | null; stdout: string }>> = {}) {
  mockedLaunchable.mockImplementation((kind) => binaries[kind])
  mockedProbeVersion.mockResolvedValue("1.2.3")
  mockedRunCli.mockImplementation(async (path) => ({
    stderr: "",
    timedOut: false,
    ...(status[path] ?? { code: 1, stdout: "" }),
  }))
}

async function check(kind: AgentKind, environment: Parameters<typeof checkAgents>[0] = { env: {}, platform: "darwin" }) {
  const found = (await checkAgents(environment)).find((agent) => agent.kind === kind)
  if (!found) throw new Error(`no ${kind} row`)
  return found
}

describe("checkAgents", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("covers each agent a person installs, default first, and forgets remembered binaries first", async () => {
    machine({})
    const agents = await checkAgents({ env: {}, platform: "darwin" })

    expect(agents.map((agent) => agent.kind)).toEqual(installableDescriptors().map((descriptor) => descriptor.kind))
    expect(agents[0].kind).toBe("claude")
    expect(agents.map((agent) => agent.kind)).not.toContain("acp")
    expect(rediscoverExecutables).toHaveBeenCalledOnce()
  })

  it("reports a missing CLI with its install page and this platform's install command", async () => {
    machine({})

    const mac = await check("claude")
    expect(mac).toMatchObject({ binary: null, version: null, signIn: null })
    expect(mac.install).toEqual({ page: "https://code.claude.com/docs/en/setup", command: "curl -fsSL https://claude.ai/install.sh | bash" })
    expect((await check("claude", { env: {}, platform: "win32" })).install.command).toBe("irm https://claude.ai/install.ps1 | iex")
    expect(mockedRunCli).not.toHaveBeenCalled()
  })

  it("reads the CLI's own offline status report for an installed agent", async () => {
    machine(
      { claude: { path: "/usr/local/bin/claude", source: "path" } },
      { "/usr/local/bin/claude": { code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }) } },
    )

    const claude = await check("claude")

    expect(claude).toMatchObject({ version: "1.2.3", signedIn: false })
    expect(claude.signIn).toEqual({ executable: "/usr/local/bin/claude", args: ["auth", "login"], command: "claude auth login" })
    expect(mockedRunCli).toHaveBeenCalledWith("/usr/local/bin/claude", ["auth", "status", "--json"], 5_000)
  })

  it("spells out the bundled copy's path, which no terminal finds by name", async () => {
    const bundled = "/Users/me/Library/App Support/node_modules/sdk/claude"
    machine({ claude: { path: bundled, source: "bundled" } })

    expect((await check("claude")).signIn?.command).toBe(`'${bundled}' auth login`)
    expect((await check("claude", { env: {}, platform: "win32" })).signIn?.command).toBe(`& "${bundled}" auth login`)
  })

  it("trusts an account token in the environment without running anything", async () => {
    machine({ claude: { path: "/usr/local/bin/claude", source: "path" } })

    await expect(check("claude", { env: { ANTHROPIC_API_KEY: "sk-test" }, platform: "darwin" })).resolves.toMatchObject({ signedIn: true })
    expect(mockedRunCli).not.toHaveBeenCalled()
  })

  it("answers unknown when the status command times out or says nothing usable", async () => {
    machine(
      { claude: { path: "/bin/claude", source: "path" }, codex: { path: "/bin/codex", source: "path" } },
      { "/bin/claude": { code: null, stdout: "" }, "/bin/codex": { code: 2, stdout: "error: unexpected argument" } },
    )

    await expect(check("claude")).resolves.toMatchObject({ signedIn: "unknown" })
    await expect(check("codex")).resolves.toMatchObject({ signedIn: "unknown" })
  })

  it("answers unknown for a CLI with no status command and no token in the environment", async () => {
    machine({ copilot: { path: "/opt/homebrew/bin/copilot", source: "path" } })

    await expect(check("copilot")).resolves.toMatchObject({ signedIn: "unknown", signIn: { command: "copilot login" } })
    await expect(check("copilot", { env: { GH_TOKEN: "gho_x" }, platform: "darwin" })).resolves.toMatchObject({ signedIn: true })
  })
})

describe("descriptor sign-in readers", () => {
  const read = (kind: AgentKind, code: number | null, stdout: string, stderr = "") =>
    descriptorFor(kind).cli.signIn?.readStatus({ code, stdout, stderr })

  it("reads Claude Code's JSON status, which exits 1 while signed out", () => {
    expect(read("claude", 0, JSON.stringify({ loggedIn: true }))).toBe(true)
    expect(read("claude", 1, JSON.stringify({ loggedIn: false, authMethod: "none" }))).toBe(false)
    expect(read("claude", 1, "error: unknown command 'auth'")).toBe("unknown")
    expect(read("claude", 0, JSON.stringify({}))).toBe("unknown")
    expect(read("claude", null, "")).toBe("unknown")
  })

  it("reads Codex's exit code and its not-logged-in wording", () => {
    expect(read("codex", 0, "Logged in using ChatGPT")).toBe(true)
    expect(read("codex", 1, "", "Not logged in")).toBe(false)
    expect(read("codex", 1, "", "panic")).toBe("unknown")
  })

  it("gives the configuration-only agent no install or sign-in facts", () => {
    expect(descriptorFor("acp").cli.install).toBeNull()
    expect(descriptorFor("acp").cli.signIn).toBeNull()
  })
})

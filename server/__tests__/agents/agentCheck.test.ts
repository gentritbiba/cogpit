// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LaunchableExecutable } from "../../agents/executables"
import type { AgentKind } from "../../../shared/session/types"

const mocks = vi.hoisted(() => ({
  findLaunchableExecutable: vi.fn(),
  probeCliVersion: vi.fn(),
  runCli: vi.fn(),
}))
vi.mock("../../agents/executables", () => ({ findLaunchableExecutable: mocks.findLaunchableExecutable }))
vi.mock("../../lib/cliProcess", () => ({ probeCliVersion: mocks.probeCliVersion, runCli: mocks.runCli }))

import { checkAgents } from "../../agents/agentCheck"
import { agentReadiness } from "../../../shared/contracts/agentCheck"
import { descriptorFor, installableDescriptors } from "../../../shared/session/agent-descriptors"

type Status = { code: number | null; stdout: string }

/** What each agent's lookup finds, and what each binary's status command prints. */
function machine(binaries: Partial<Record<AgentKind, LaunchableExecutable>>, status: Record<string, Status> = {}) {
  mocks.findLaunchableExecutable.mockImplementation(async (kind: AgentKind) => binaries[kind] ?? { status: "absent" })
  mocks.probeCliVersion.mockResolvedValue("1.2.3")
  mocks.runCli.mockImplementation(async (path: string) => ({
    stderr: "",
    timedOut: false,
    ...(status[path] ?? { code: 1, stdout: "" }),
  }))
}

const onPath = (path: string): LaunchableExecutable => ({ status: "found", path, source: "path" })

async function check(kind: AgentKind, environment: Parameters<typeof checkAgents>[0] = { env: {}, platform: "darwin" }) {
  const found = (await checkAgents(environment)).find((agent) => agent.kind === kind)
  if (!found) throw new Error(`no ${kind} row`)
  return found
}

describe("checkAgents", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("covers each agent a person installs, default first", async () => {
    machine({})
    const agents = await checkAgents({ env: {}, platform: "darwin" })

    expect(agents.map((agent) => agent.kind)).toEqual(installableDescriptors().map((descriptor) => descriptor.kind))
    expect(agents[0].kind).toBe("claude")
    expect(agents.map((agent) => agent.kind)).not.toContain("acp")
  })

  it("reports a missing CLI with its install page and this platform's install command", async () => {
    machine({})

    const mac = await check("claude")
    expect(mac).toMatchObject({ binary: null, unlaunchableChoice: null, version: null, signIn: null })
    expect(mac.install).toEqual({ page: "https://code.claude.com/docs/en/setup", command: "curl -fsSL https://claude.ai/install.sh | bash" })
    expect((await check("claude", { env: {}, platform: "win32" })).install.command).toBe("irm https://claude.ai/install.ps1 | iex")
    expect(mocks.runCli).not.toHaveBeenCalled()
  })

  it("reads the CLI's own offline status report for an installed agent", async () => {
    machine(
      { claude: onPath("/usr/local/bin/claude") },
      { "/usr/local/bin/claude": { code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }) } },
    )

    const claude = await check("claude")

    expect(claude).toMatchObject({ version: "1.2.3", signedIn: false })
    expect(claude.signIn).toEqual({ executable: "/usr/local/bin/claude", args: ["auth", "login"], command: "claude auth login" })
    expect(mocks.runCli).toHaveBeenCalledWith("/usr/local/bin/claude", ["auth", "status", "--json"], 5_000)
  })

  it("returns only the sign-in verdict, never the account the status report names", async () => {
    machine(
      { claude: onPath("/usr/local/bin/claude") },
      { "/usr/local/bin/claude": { code: 0, stdout: JSON.stringify({
        loggedIn: true,
        email: "person@example.com",
        orgName: "Example Org",
        orgId: "org-123",
      }) } },
    )

    const agents = await checkAgents({ env: {}, platform: "darwin" })
    const body = JSON.stringify(agents)

    expect(agents[0].signedIn).toBe(true)
    for (const secret of ["person@example.com", "Example Org", "org-123"]) expect(body).not.toContain(secret)
  })

  it("spells out the bundled copy's path, which no terminal finds by name", async () => {
    const bundled = "/Users/me/Library/App Support/node_modules/sdk/claude"
    machine({ claude: { status: "found", path: bundled, source: "bundled" } })

    expect((await check("claude")).signIn?.command).toBe(`'${bundled}' auth login`)
    expect((await check("claude", { env: {}, platform: "win32" })).signIn?.command).toBe(`& '${bundled}' auth login`)
  })

  it("quotes an apostrophe in the copied command the way PowerShell needs", async () => {
    const bundled = "C:\\Users\\O'Brien\\AppData\\Local\\Programs\\cogpit\\claude.exe"
    machine({ claude: { status: "found", path: bundled, source: "bundled" } })

    expect((await check("claude", { env: {}, platform: "win32" })).signIn).toEqual({
      executable: bundled,
      args: ["auth", "login"],
      command: "& 'C:\\Users\\O''Brien\\AppData\\Local\\Programs\\cogpit\\claude.exe' auth login",
    })
  })

  it("reports a deleted custom executable as not found, even with an account token set", async () => {
    machine({ claude: { status: "unlaunchable-choice", path: "/opt/old/claude" } })

    const claude = await check("claude", { env: { ANTHROPIC_API_KEY: "sk-test" }, platform: "darwin" })

    expect(claude).toMatchObject({
      binary: null,
      unlaunchableChoice: { path: "/opt/old/claude" },
      version: null,
      signedIn: "unknown",
      signIn: null,
    })
    expect(agentReadiness(claude)).toBe("not-found")
    expect(mocks.probeCliVersion).not.toHaveBeenCalled()
    expect(mocks.runCli).not.toHaveBeenCalled()
  })

  it("trusts an account token in the environment without running anything", async () => {
    machine({ claude: onPath("/usr/local/bin/claude") })

    await expect(check("claude", { env: { ANTHROPIC_API_KEY: "sk-test" }, platform: "darwin" })).resolves.toMatchObject({ signedIn: true })
    expect(mocks.runCli).not.toHaveBeenCalled()
  })

  it("answers unknown when the status command times out or says nothing usable", async () => {
    machine(
      { claude: onPath("/bin/claude"), codex: onPath("/bin/codex") },
      { "/bin/claude": { code: null, stdout: "" }, "/bin/codex": { code: 2, stdout: "error: unexpected argument" } },
    )

    await expect(check("claude")).resolves.toMatchObject({ signedIn: "unknown" })
    await expect(check("codex")).resolves.toMatchObject({ signedIn: "unknown" })
  })

  it("answers unknown for a CLI with no status command and no token in the environment", async () => {
    machine({ copilot: onPath("/opt/homebrew/bin/copilot") })

    await expect(check("copilot")).resolves.toMatchObject({ signedIn: "unknown", signIn: { command: "copilot login" } })
    await expect(check("copilot", { env: { GH_TOKEN: "gho_x" }, platform: "darwin" })).resolves.toMatchObject({ signedIn: true })
  })
})

describe("sharedAgentCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    machine({ claude: onPath("/usr/local/bin/claude") })
  })

  async function freshModule() {
    return import("../../agents/agentCheck")
  }

  it("runs once for callers that arrive while a check is in flight", async () => {
    const { sharedAgentCheck } = await freshModule()
    let release!: () => void
    mocks.findLaunchableExecutable.mockImplementation(async (kind: AgentKind) => {
      if (kind === "claude") await new Promise<void>((resolve) => { release = resolve })
      return kind === "claude" ? onPath("/usr/local/bin/claude") : { status: "absent" }
    })

    const first = sharedAgentCheck()
    const second = sharedAgentCheck()
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    release()

    expect(await first).toBe(await second)
    expect(mocks.findLaunchableExecutable).toHaveBeenCalledTimes(installableDescriptors().length)
  })

  it("checks afresh right after a finished check, so an agent installed meanwhile shows up", async () => {
    const { sharedAgentCheck } = await freshModule()
    const before = await sharedAgentCheck()
    expect(before.find((agent) => agent.kind === "codex")?.binary).toBeNull()

    machine({ claude: onPath("/usr/local/bin/claude"), codex: onPath("/usr/local/bin/codex") })
    const after = await sharedAgentCheck()

    expect(after.find((agent) => agent.kind === "codex")?.binary).toEqual({ path: "/usr/local/bin/codex", source: "path" })
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

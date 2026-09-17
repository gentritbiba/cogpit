// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { executeCloudflareIntegration, executeWrangler, mapWranglerFailure, runWrangler, type CloudflareDependencies, type WranglerProject } from "../../plugins/integrations/cloudflare"
import type { PluginIntegrationContext } from "../../plugins/integrationTypes"

const resolver = vi.hoisted(() => vi.fn())
vi.mock("../../lib/binaryResolver", () => ({ resolveAgentCommand: resolver }))

const VERSION_ID = "a5d6631d-f96f-4917-bec2-5a31678c58fe"
const OLDER_VERSION_ID = "616630a4-2edd-4ceb-8e19-100361abda6e"
const project: WranglerProject = {
  root: "/repo/apps/api", configPath: "/repo/apps/api/wrangler.toml", key: "apps/api/wrangler.toml", repositoryRoot: "/repo",
  config: { name: "tenant-router", compatibility_date: "2024-01-01", routes: ["example.com/*"], kv_namespaces: [{ binding: "TENANT_MAP", id: "1" }], env: { staging: { vars: { STAGE: "staging" } } } },
}
const identity = { loggedIn: true, authType: "OAuth Token", email: "dev@example.com", accounts: [{ id: "48a839769a4ad0a20e5d71f2950d1b4d", name: "Dev account" }] }
const deployments = [
  { id: "older", source: "wrangler", strategy: "percentage", author_email: "dev@example.com", annotations: { "workers/triggered_by": "deployment" }, versions: [{ version_id: OLDER_VERSION_ID, percentage: 100 }], created_on: "2026-09-02T22:31:56.249056Z" },
  { id: "newer", source: "wrangler", strategy: "percentage", author_email: "dev@example.com", annotations: { "workers/message": "PR 167", "workers/triggered_by": "deployment" }, versions: [{ version_id: VERSION_ID, percentage: 100 }], created_on: "2026-09-06T11:29:57.586976Z" },
  { id: "broken" },
]
const version = {
  id: VERSION_ID, number: 22,
  metadata: { created_on: "2026-09-06T11:29:55.780132Z", source: "wrangler", author_id: "author", author_email: "dev@example.com", has_preview: true },
  annotations: { "workers/message": "PR 167", "workers/tag": "d627fd8", "workers/triggered_by": "version_upload" },
  resources: {
    script: { etag: "e26e", handlers: ["fetch"], last_deployed_from: "wrangler" },
    script_runtime: { compatibility_date: "2024-01-01", compatibility_flags: ["brotli_content_encoding"], usage_model: "standard" },
    bindings: [{ name: "ORIGIN_HOST", text: "origin.example.com", type: "plain_text" }, { name: "ORIGIN_SECRET", type: "secret_text" }, { name: "TENANT_MAP", namespace_id: "1", type: "kv_namespace" }],
  },
}
const context = (signal = new AbortController().signal): PluginIntegrationContext => ({ workspacePath: project.root, signal, authorize: vi.fn(async () => {}) })
function fixture(overrides: Partial<CloudflareDependencies> = {}) {
  const dependencies: CloudflareDependencies = {
    resolveProjects: vi.fn(async () => [project]),
    wrangler: vi.fn(async (_project, args) => args[0] === "whoami" ? identity : args[0] === "deployments" ? deployments : version),
    environment: {},
    ...overrides,
  }
  return dependencies
}
const calls = (dependencies: CloudflareDependencies) => vi.mocked(dependencies.wrangler).mock.calls.map(call => call[1])
afterEach(() => vi.restoreAllMocks())

describe("Cloudflare installed-package integration", () => {
  it("describes the Worker, its environments and the signed-in account", async () => {
    const dependencies = fixture(), owner = context()
    await expect(executeCloudflareIntegration({ integration: "cloudflare", operation: "workspace" }, owner, dependencies)).resolves.toEqual({
      workerName: "tenant-router", configPath: "apps/api/wrangler.toml", configs: ["apps/api/wrangler.toml"],
      environments: [
        { name: null, workerName: "tenant-router", routes: ["example.com/*"], crons: [], bindings: [{ name: "TENANT_MAP", type: "kv_namespaces", target: null }], compatibilityDate: "2024-01-01", dashboardUrl: "https://dash.cloudflare.com/48a839769a4ad0a20e5d71f2950d1b4d/workers/services/view/tenant-router/production" },
        { name: "staging", workerName: "tenant-router-staging", routes: ["example.com/*"], crons: [], bindings: [{ name: "STAGE", type: "vars", target: null }], compatibilityDate: "2024-01-01", dashboardUrl: "https://dash.cloudflare.com/48a839769a4ad0a20e5d71f2950d1b4d/workers/services/view/tenant-router-staging/production" },
      ],
      email: "dev@example.com",
      account: { id: "48a839769a4ad0a20e5d71f2950d1b4d", name: "Dev account" },
    })
    expect(dependencies.resolveProjects).toHaveBeenCalledWith(project.root, expect.any(AbortSignal))
    expect(calls(dependencies)).toEqual([["whoami", "--json"]])
    expect(owner.authorize).toHaveBeenCalled()
  })

  it("selects the configured account among several and leaves the account unknown when nothing selects one", async () => {
    const accounts = [{ id: "1111111111111111111111111111111a", name: "One" }, { id: "2222222222222222222222222222222b", name: "Two" }]
    const multi = fixture({ wrangler: vi.fn(async () => ({ ...identity, accounts })), environment: { CLOUDFLARE_ACCOUNT_ID: accounts[1].id } })
    await expect(executeCloudflareIntegration({ integration: "cloudflare", operation: "workspace" }, context(), multi)).resolves.toMatchObject({ account: accounts[1] })
    const configured = fixture({ resolveProjects: vi.fn(async () => [{ ...project, config: { ...project.config, account_id: accounts[0].id } }]), wrangler: vi.fn(async () => ({ ...identity, accounts })) })
    await expect(executeCloudflareIntegration({ integration: "cloudflare", operation: "workspace" }, context(), configured)).resolves.toMatchObject({ account: accounts[0] })
    const unknown = fixture({ wrangler: vi.fn(async () => ({ ...identity, accounts })) })
    await expect(executeCloudflareIntegration({ integration: "cloudflare", operation: "workspace" }, context(), unknown)).resolves.toMatchObject({ account: null, environments: [{ dashboardUrl: null }, { dashboardUrl: null }] })
  })

  it("reports a signed-out Wrangler as an authentication problem", async () => {
    const dependencies = fixture({ wrangler: vi.fn(async () => ({ loggedIn: false })) })
    await expect(executeCloudflareIntegration({ integration: "cloudflare", operation: "workspace" }, context(), dependencies)).rejects.toMatchObject({ code: "cloudflare_auth_required" })
  })

  it("lists deployments newest first, drops malformed rows and applies the limit", async () => {
    const dependencies = fixture()
    await expect(executeCloudflareIntegration({ integration: "cloudflare", operation: "deployments", limit: 1 }, context(), dependencies)).resolves.toEqual({
      workerName: "tenant-router", environment: null,
      deployments: [{ id: "newer", createdAt: "2026-09-06T11:29:57.586976Z", source: "wrangler", strategy: "percentage", author: "dev@example.com", message: "PR 167", triggeredBy: "deployment", versions: [{ id: VERSION_ID, percentage: 100 }] }],
    })
    expect(calls(dependencies)).toEqual([["deployments", "list", "--json"]])
  })

  it("passes a declared environment through and rejects undeclared ones before running Wrangler", async () => {
    const dependencies = fixture()
    await expect(executeCloudflareIntegration({ integration: "cloudflare", operation: "deployments", environment: "staging" }, context(), dependencies)).resolves.toMatchObject({ workerName: "tenant-router-staging", environment: "staging" })
    expect(calls(dependencies)).toEqual([["deployments", "list", "--json", "--env", "staging"]])
    await expect(executeCloudflareIntegration({ integration: "cloudflare", operation: "deployments", environment: "production" }, context(), dependencies)).rejects.toMatchObject({ code: "cloudflare_config_invalid" })
    expect(dependencies.wrangler).toHaveBeenCalledTimes(1)
  })

  it("returns version details with binding names and types but no values", async () => {
    const dependencies = fixture()
    const result = await executeCloudflareIntegration({ integration: "cloudflare", operation: "version", versionId: VERSION_ID }, context(), dependencies)
    expect(result).toEqual({ version: {
      id: VERSION_ID, number: 22, createdAt: "2026-09-06T11:29:55.780132Z", source: "wrangler", author: "dev@example.com", message: "PR 167", tag: "d627fd8", triggeredBy: "version_upload", hasPreview: true,
      compatibilityDate: "2024-01-01", compatibilityFlags: ["brotli_content_encoding"], handlers: ["fetch"], usageModel: "standard",
      bindings: [{ name: "ORIGIN_HOST", type: "plain_text" }, { name: "ORIGIN_SECRET", type: "secret_text" }, { name: "TENANT_MAP", type: "kv_namespace" }],
    } })
    expect(JSON.stringify(result)).not.toContain("origin.example.com")
    expect(calls(dependencies)).toEqual([["versions", "view", VERSION_ID, "--json"]])
  })

  it("rejects a version that does not match the requested identity", async () => {
    const dependencies = fixture({ wrangler: vi.fn(async () => ({ ...version, id: OLDER_VERSION_ID })) })
    await expect(executeCloudflareIntegration({ integration: "cloudflare", operation: "version", versionId: VERSION_ID }, context(), dependencies)).rejects.toMatchObject({ code: "invalid_response" })
  })

  it("selects another discovered project by its configuration path and rejects unknown ones", async () => {
    const other: WranglerProject = { ...project, root: "/repo/apps/edge", configPath: "/repo/apps/edge/wrangler.jsonc", key: "apps/edge/wrangler.jsonc", config: { name: "edge" } }
    const dependencies = fixture({ resolveProjects: vi.fn(async () => [project, other]) })
    await expect(executeCloudflareIntegration({ integration: "cloudflare", operation: "workspace" }, context(), dependencies)).resolves.toMatchObject({ workerName: "tenant-router", configPath: "apps/api/wrangler.toml", configs: ["apps/api/wrangler.toml", "apps/edge/wrangler.jsonc"] })
    await expect(executeCloudflareIntegration({ integration: "cloudflare", operation: "deployments", config: "apps/edge/wrangler.jsonc" }, context(), dependencies)).resolves.toMatchObject({ workerName: "edge" })
    expect(vi.mocked(dependencies.wrangler).mock.calls.at(-1)?.[0]).toBe(other)
    await expect(executeCloudflareIntegration({ integration: "cloudflare", operation: "deployments", config: "apps/none/wrangler.toml" }, context(), dependencies)).rejects.toMatchObject({ code: "cloudflare_config_invalid" })
  })

  it("rejects Pages configurations before running Wrangler", async () => {
    const dependencies = fixture({ resolveProjects: vi.fn(async () => [{ ...project, config: { name: "site", pages_build_output_dir: "dist" } }]) })
    await expect(executeCloudflareIntegration({ integration: "cloudflare", operation: "deployments" }, context(), dependencies)).rejects.toMatchObject({ code: "cloudflare_pages_unsupported" })
    expect(dependencies.wrangler).not.toHaveBeenCalled()
  })

  it("does not continue after authorization is revoked during a read", async () => {
    const dependencies = fixture(), owner = context()
    vi.mocked(dependencies.wrangler).mockImplementation(async () => { vi.mocked(owner.authorize).mockRejectedValue(new Error("Revoked")); return deployments })
    await expect(executeCloudflareIntegration({ integration: "cloudflare", operation: "deployments" }, owner, dependencies)).rejects.toThrow("Revoked")
  })

  it("refuses canceled work before reading the configuration", async () => {
    const abort = new AbortController(), dependencies = fixture(); abort.abort()
    await expect(executeCloudflareIntegration({ integration: "cloudflare", operation: "deployments" }, context(abort.signal), dependencies)).rejects.toThrow()
    expect(dependencies.resolveProjects).not.toHaveBeenCalled()
  })
})

describe("Wrangler command runner", () => {
  it("checks the CLI version, appends the configuration path and parses JSON after banners", async () => {
    const command = vi.fn().mockResolvedValueOnce({ stdout: "\n 4.129.0\n", stderr: "" }).mockResolvedValueOnce({ stdout: "\n ⛅️ wrangler 4.129.0\n[{\"id\":\"x\"}]\n", stderr: "" })
    await expect(runWrangler(project, ["deployments", "list", "--json"], context(), command)).resolves.toEqual([{ id: "x" }])
    expect(command.mock.calls.map(call => call[1])).toEqual([["--version"], ["deployments", "list", "--json", "--config", project.configPath]])
  })

  it("remembers a passed version probe per runner instead of spawning Wrangler twice per read", async () => {
    const command = vi.fn().mockImplementation(async (_project, args: string[]) => ({ stdout: args[0] === "--version" ? "4.129.0" : "{}", stderr: "" }))
    await runWrangler(project, ["whoami", "--json"], context(), command)
    await runWrangler(project, ["deployments", "list", "--json"], context(), command)
    expect(command.mock.calls.map(call => call[1][0])).toEqual(["--version", "whoami", "deployments"])
    const other = vi.fn().mockImplementation(async (_project, args: string[]) => ({ stdout: args[0] === "--version" ? "4.129.0" : "{}", stderr: "" }))
    await runWrangler(project, ["whoami", "--json"], context(), other)
    expect(other.mock.calls.map(call => call[1][0])).toEqual(["--version", "whoami"])
  })

  it("refuses Wrangler older than 4.65.0", async () => {
    const command = vi.fn().mockResolvedValue({ stdout: "4.42.2", stderr: "" })
    await expect(runWrangler(project, ["whoami", "--json"], context(), command)).rejects.toMatchObject({ code: "wrangler_too_old" })
    expect(command).toHaveBeenCalledOnce()
  })

  it("checks authorization again after the CLI version probe", async () => {
    const owner = context()
    const command = vi.fn().mockImplementation(async () => { vi.mocked(owner.authorize).mockRejectedValue(new Error("Revoked")); return { stdout: "4.129.0", stderr: "" } })
    await expect(runWrangler(project, ["whoami", "--json"], owner, command)).rejects.toThrow("Revoked")
    expect(command).toHaveBeenCalledOnce()
  })

  it.each([
    [{ code: "ENOENT" }, "wrangler_missing"],
    [{ stderr: "Unknown argument: json" }, "wrangler_too_old"],
    [{ stderr: "✘ [ERROR] A request to the Cloudflare API (/accounts/x/workers/scripts/y/deployments) failed.\n\n  Authentication error [code: 10000]" }, "cloudflare_auth_required"],
    [{ stderr: "Authentication failed (status: 400) [code: 9106]" }, "cloudflare_auth_required"],
    [{ stdout: "{\"loggedIn\":false}", stderr: "" }, "cloudflare_auth_required"],
    [{ stderr: "This Worker does not exist on your account. [code: 10007]" }, "cloudflare_worker_missing"],
    [{ stderr: "More than one account available but unable to select one in non-interactive mode. Please set the appropriate `account_id` in your Wrangler configuration file." }, "cloudflare_account_required"],
    [{ stderr: "You are not authorized to access this resource [code: 10021]" }, "cloudflare_access_denied"],
    [{ stderr: "Something else broke" }, "cloudflare_api_failed"],
  ])("maps %o to %s without exposing provider output", (failure, code) => {
    const mapped = mapWranglerFailure({ message: "Command failed synthetic-private-test-value", ...failure })
    expect(mapped.code).toBe(code)
    expect(mapped.message).not.toContain("synthetic-private-test-value")
  })

  it("reports invalid JSON as an invalid response", async () => {
    const command = vi.fn().mockResolvedValueOnce({ stdout: "4.129.0", stderr: "" }).mockResolvedValueOnce({ stdout: "not json", stderr: "" })
    await expect(runWrangler(project, ["whoami", "--json"], context(), command)).rejects.toMatchObject({ code: "invalid_response" })
  })

  it("aborts the actual spawned CLI process when its activation signal is canceled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cogpit-wrangler-cli-")), pidFile = join(directory, "pid")
    let childPid = 0
    const abort = new AbortController()
    resolver.mockReturnValue({ command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000)`], spawnOptions: {} })
    try {
      const pending = executeWrangler({ ...project, root: directory, repositoryRoot: null }, ["--version"], { ...context(abort.signal), workspacePath: directory })
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
      await vi.waitFor(async () => { childPid = Number(await readFile(pidFile, "utf8")); expect(childPid).toBeGreaterThan(0) })
      abort.abort(); await rejected
      await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow())
      expect(resolver).toHaveBeenCalledWith("wrangler", ["--version"])
    } finally {
      abort.abort()
      if (childPid) { try { process.kill(childPid, "SIGKILL") } catch { /* The signal already terminated the child. */ } }
      await rm(directory, { recursive: true, force: true })
    }
  })
})

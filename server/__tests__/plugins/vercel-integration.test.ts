// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { executeVercel, executeVercelIntegration, runVercelApi, type VercelDeploymentDependencies } from "../../plugins/integrations/vercel"
import type { PluginIntegrationContext } from "../../plugins/integrationTypes"

const resolver = vi.hoisted(() => vi.fn())
vi.mock("../../lib/binaryResolver", () => ({ resolveAgentCommand: resolver }))
const project = { root: "/repo/worktree", projectId: "prj_ours", teamId: "team_shared", projectName: "Worktree project" }
const context = (signal = new AbortController().signal): PluginIntegrationContext => ({ workspacePath: project.root, signal, authorize: vi.fn(async () => {}) })
function fixture(detail: unknown = { id: "dpl_selected", projectId: "prj_ours" }) {
  const dependencies: VercelDeploymentDependencies = { resolveProject: vi.fn(async () => project), vercelApi: vi.fn(async (_project, endpoint) => endpoint.startsWith("/v13/") ? detail : [{ id: "event", text: "Build complete", created: 1, type: "stdout" }]) }
  return dependencies
}
afterEach(() => vi.restoreAllMocks())

describe("Vercel installed-package integration", () => {
  it.each([{ id: "dpl_selected", projectId: "prj_ours" }, { id: "dpl_selected", project: { id: "prj_ours" } }])("verifies project ownership before reading build output", async detail => {
    const dependencies = fixture(detail), owner = context()
    await expect(executeVercelIntegration({ integration: "vercel", operation: "buildLogs", deploymentId: "dpl_selected" }, owner, dependencies)).resolves.toEqual({ deploymentId: "dpl_selected", events: [{ id: "event", text: "Build complete", createdAt: 1, type: "stdout" }] })
    expect(dependencies.resolveProject).toHaveBeenCalledWith("/repo/worktree", expect.any(AbortSignal))
    expect(vi.mocked(dependencies.vercelApi).mock.calls.map(call => call[1])).toEqual(["/v13/deployments/dpl_selected?teamId=team_shared", "/v3/deployments/dpl_selected/events?teamId=team_shared&direction=backward&limit=200"])
    expect(owner.authorize).toHaveBeenCalled()
  })
  it.each([
    { id: "dpl_selected", projectId: "prj_other" },
    { id: "dpl_other", projectId: "prj_ours" },
    { id: "dpl_selected", projectId: "prj_ours", project: { id: "prj_other" } },
    { id: "dpl_selected", teamId: "team_shared" },
    null,
  ])("denies foreign, conflicting or absent project ownership without fetching logs", async detail => {
    const dependencies = fixture(detail)
    await expect(executeVercelIntegration({ integration: "vercel", operation: "buildLogs", deploymentId: "dpl_selected" }, context(), dependencies)).rejects.toMatchObject({ status: 403, code: "vercel_access_denied" })
    expect(dependencies.vercelApi).toHaveBeenCalledTimes(1)
  })
  it("does not continue after authorization is revoked during the ownership read", async () => {
    const dependencies = fixture(), owner = context()
    vi.mocked(dependencies.vercelApi).mockImplementation(async () => { vi.mocked(owner.authorize).mockRejectedValue(new Error("Revoked")); return { id: "dpl_selected", projectId: "prj_ours" } })
    await expect(executeVercelIntegration({ integration: "vercel", operation: "buildLogs", deploymentId: "dpl_selected" }, owner, dependencies)).rejects.toThrow("Revoked")
    expect(dependencies.vercelApi).toHaveBeenCalledTimes(1)
  })
  it("does not continue after cancellation during the ownership read", async () => {
    const abort = new AbortController(), dependencies = fixture()
    vi.mocked(dependencies.vercelApi).mockImplementation(async () => { abort.abort(); return { id: "dpl_selected", projectId: "prj_ours" } })
    await expect(executeVercelIntegration({ integration: "vercel", operation: "buildLogs", deploymentId: "dpl_selected" }, context(abort.signal), dependencies)).rejects.toThrow()
    expect(dependencies.vercelApi).toHaveBeenCalledTimes(1)
  })
  it("refuses canceled work before reading a project link", async () => {
    const abort = new AbortController(), dependencies = fixture(); abort.abort()
    await expect(executeVercelIntegration({ integration: "vercel", operation: "deployments" }, context(abort.signal), dependencies)).rejects.toThrow()
    expect(dependencies.resolveProject).not.toHaveBeenCalled()
  })
  it("keeps provider failure details out of returned errors", async () => {
    const command = vi.fn().mockRejectedValue({ stderr: "Unauthorized synthetic-private-test-value", stdout: "raw output", message: "command failed" })
    await expect(runVercelApi(project, "/v7/deployments", context(), command)).rejects.toMatchObject({ code: "vercel_auth_required", message: "Sign in with `vercel login` to view deployments" })
  })
  it("checks authorization again after the CLI version probe", async () => {
    const owner = context()
    const command = vi.fn().mockImplementation(async () => { vi.mocked(owner.authorize).mockRejectedValue(new Error("Revoked")); return { stdout: "50.5.1", stderr: "" } })
    await expect(runVercelApi(project, "/v7/deployments", owner, command)).rejects.toThrow("Revoked")
    expect(command).toHaveBeenCalledOnce()
  })
  it("aborts the actual spawned CLI process when its activation signal is canceled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cogpit-vercel-cli-")), pidFile = join(directory, "pid")
    let childPid = 0
    const abort = new AbortController()
    resolver.mockReturnValue({ command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000)`], spawnOptions: {} })
    try {
      const pending = executeVercel(directory, ["--version"], { ...context(abort.signal), workspacePath: directory })
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
      await vi.waitFor(async () => { childPid = Number(await readFile(pidFile, "utf8")); expect(childPid).toBeGreaterThan(0) })
      abort.abort(); await rejected
      await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow())
      expect(resolver).toHaveBeenCalledWith("vercel", ["--version"])
    } finally {
      abort.abort()
      if (childPid) { try { process.kill(childPid, "SIGKILL") } catch { /* The signal already terminated the child. */ } }
      await rm(directory, { recursive: true, force: true })
    }
  })
})

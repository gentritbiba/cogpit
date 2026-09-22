// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { executeGitHubIntegration, runGitHubApi, runGitHubMutation, type GitHubDependencies } from "../../plugins/integrations/github"

function fixture() {
  const controller = new AbortController()
  const authorize = vi.fn(async () => {})
  const deps: GitHubDependencies = {
    resolveProject: vi.fn().mockResolvedValue({ ok: true, root: "/repo", projectPath: "/repo" }),
    git: vi.fn().mockImplementation(async (_cwd, args) => ({ stdout: args[0] === "remote" ? "git@github.com:acme/app.git" : "main", stderr: "" })),
    githubApi: vi.fn().mockResolvedValue({ workflow_runs: [] }),
    githubMutate: vi.fn().mockResolvedValue({ merged: true, sha: "c".repeat(40), message: "Pull Request successfully merged" }),
    githubGraphql: vi.fn(), pullRequestSessions: vi.fn(),
  }
  return { controller, authorize, deps, context: { workspacePath: "/repo", signal: controller.signal, authorize } }
}
const headSha = "b".repeat(40)

describe("GitHub merge operation", () => {
  it("merges through the REST endpoint with the method and head commit pinned", async () => {
    const { deps, context } = fixture()
    await expect(executeGitHubIntegration({ integration: "github", operation: "mergePull", number: 128, method: "squash", headSha }, context, deps))
      .resolves.toEqual({ repository: "acme/app", number: 128, merged: true, sha: "c".repeat(40), message: "Pull Request successfully merged" })
    expect(deps.githubMutate).toHaveBeenCalledWith({ host: "github.com", owner: "acme", name: "app" }, "PUT", "repos/acme/app/pulls/128/merge", { merge_method: "squash", sha: headSha }, context.signal)
  })
  it.each([
    { number: 0, headSha },
    { number: 1.5, headSha },
    { number: 128, headSha: "abc123" },
  ])("refuses a malformed merge target before contacting GitHub: %o", async (target) => {
    const { deps, context } = fixture()
    await expect(executeGitHubIntegration({ integration: "github", operation: "mergePull", method: "merge", ...target }, context, deps)).rejects.toMatchObject({ status: 400 })
    expect(deps.githubMutate).not.toHaveBeenCalled()
  })
  it("rejects a merge GitHub reports as not performed", async () => {
    const { deps, context } = fixture()
    vi.mocked(deps.githubMutate).mockResolvedValueOnce({ merged: "yes" })
    await expect(executeGitHubIntegration({ integration: "github", operation: "mergePull", number: 128, method: "merge", headSha }, context, deps)).rejects.toMatchObject({ code: "invalid_response" })
  })
  it.skipIf(process.platform === "win32")("surfaces GitHub's reason and status when the CLI reports a refused merge", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cogpit-github-merge-"))
    await writeFile(join(directory, "gh"), `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ message: "Pull Request is not mergeable" }))\nprocess.stderr.write("gh: Pull Request is not mergeable (HTTP 405)\\n")\nprocess.exit(1)\n`, { mode: 0o700 })
    vi.stubEnv("PATH", `${directory}${delimiter}${dirname(process.execPath)}`)
    try {
      await expect(runGitHubMutation({ host: "github.com", owner: "acme", name: "app" }, "PUT", "repos/acme/app/pulls/128/merge", { merge_method: "merge", sha: headSha }))
        .rejects.toMatchObject({ status: 405, code: "github_api_failed", message: "GitHub declined the change: Pull Request is not mergeable" })
    } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) }
  })
})
describe("GitHub native integration cancellation and authority", () => {
  it.skipIf(process.platform === "win32")("terminates an actual CLI request when its activation is canceled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cogpit-github-cli-")), marker = join(directory, "started")
    const controller = new AbortController()
    await writeFile(join(directory, "gh"), `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ready"); setInterval(() => {}, 1000)\n`, { mode: 0o700 })
    vi.stubEnv("PATH", `${directory}${delimiter}${dirname(process.execPath)}`)
    const pending = runGitHubApi({ host: "github.com", owner: "fixture", name: "fixture" }, "repos/fixture/fixture/actions/runs", controller.signal)
    const outcome = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    try {
      let started = false
      for (let attempt = 0; attempt < 100 && !started; attempt++) { started = await readFile(marker).then(() => true, () => false); if (!started) await delay(10) }
      expect(started).toBe(true)
      controller.abort(); await outcome
    } finally { controller.abort(); await pending.catch(() => {}); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) }
  })

  it("refuses before resolving a project when authority has been lost", async () => {
    const { deps, context, authorize } = fixture()
    authorize.mockRejectedValue(new Error("revoked"))
    await expect(executeGitHubIntegration({ integration: "github", operation: "actions" }, context, deps)).rejects.toThrow("revoked")
    expect(deps.resolveProject).not.toHaveBeenCalled(); expect(deps.githubApi).not.toHaveBeenCalled()
  })
  it.each(["resolveProject", "git", "githubApi"] as const)("discards results when authority changes during %s", async dependency => {
    const { deps, context, authorize } = fixture()
    const revoke = () => authorize.mockRejectedValue(new Error("revoked"))
    if (dependency === "resolveProject") vi.mocked(deps.resolveProject).mockImplementationOnce(async () => { revoke(); return { ok: true, root: "/repo", projectPath: "/repo" } })
    else if (dependency === "git") vi.mocked(deps.git).mockImplementationOnce(async () => { revoke(); return { stdout: "git@github.com:acme/app.git", stderr: "" } })
    else vi.mocked(deps.githubApi).mockImplementationOnce(async () => { revoke(); return { workflow_runs: [] } })
    await expect(executeGitHubIntegration({ integration: "github", operation: "actions" }, context, deps)).rejects.toThrow("revoked")
    if (dependency !== "githubApi") expect(deps.githubApi).not.toHaveBeenCalled()
  })
  it("forwards cancellation to subprocess dependencies and rejects an in-flight result", async () => {
    const { deps, controller, context } = fixture()
    vi.mocked(deps.githubApi).mockImplementationOnce(async (_repo, _path, signal) => { expect(signal).toBe(controller.signal); controller.abort(); return { workflow_runs: [] } })
    await expect(executeGitHubIntegration({ integration: "github", operation: "actions" }, context, deps)).rejects.toMatchObject({ name: "AbortError" })
    expect(deps.resolveProject).toHaveBeenCalledWith("/repo", controller.signal)
    expect(deps.git).toHaveBeenCalledWith("/repo", ["remote", "get-url", "origin"], controller.signal)
  })
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("refuses unsafe provider resource IDs: %s", async runId => {
    const { deps, context } = fixture()
    await expect(executeGitHubIntegration({ integration: "github", operation: "actionJobs", runId }, context, deps)).rejects.toMatchObject({ status: 400 })
    expect(deps.resolveProject).not.toHaveBeenCalled()
  })
})

// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { executeGitHubIntegration, parseReviewFile, runGitHubPost, type GitHubDependencies } from "../../plugins/integrations/github"

const head = "b".repeat(40), base = "a".repeat(40), moved = "c".repeat(40)
const pull = (headSha = head, changed = 65) => ({ title: "Add review", html_url: "https://github.com/acme/app/pull/7", state: "open", draft: false, merged_at: null, changed_files: changed, head: { sha: headSha, ref: "feature" }, base: { sha: base, ref: "main" } })
const file = (index: number, extra: Record<string, unknown> = {}) => ({ filename: `src/file-${index}.ts`, status: "modified", additions: 1, deletions: 1, changes: 2, sha: `${index}`.padStart(40, "f"), patch: `@@ -1 +1 @@\n-old ${index}\n+new ${index}`, ...extra })

function fixture(api: (endpoint: string) => unknown) {
  const deps: GitHubDependencies = {
    resolveProject: vi.fn().mockResolvedValue({ ok: true, root: "/repo", projectPath: "/repo" }),
    git: vi.fn().mockImplementation(async (_cwd, args) => ({ stdout: args[0] === "remote" ? "git@github.com:acme/app.git" : "main", stderr: "" })),
    githubApi: vi.fn().mockImplementation(async (_repository, endpoint: string) => api(endpoint)),
    githubPost: vi.fn().mockResolvedValue({ id: 99, html_url: "https://github.com/acme/app/pull/7#pullrequestreview-99" }),
    githubMutate: vi.fn(), githubGraphql: vi.fn(), pullRequestSessions: vi.fn(),
  }
  return { deps, context: { workspacePath: "/repo", signal: new AbortController().signal, authorize: vi.fn(async () => {}), principal: "owner" } }
}

describe("pull request review pages", () => {
  it("pins base and head, pages past 100 files and marks binary, oversized and renamed files", async () => {
    const pages: Record<string, unknown[]> = {
      "1": Array.from({ length: 30 }, (_, index) => file(index)),
      "3": [file(60, { patch: undefined, changes: 0, additions: 0, deletions: 0, filename: "logo.png" }), file(61, { patch: "x".repeat(60_000) }), file(62, { status: "renamed", previous_filename: "old.ts", patch: undefined, changes: 0 }), file(63, { patch: undefined, changes: 900 }), file(64, { status: "removed" })],
    }
    const { deps, context } = fixture((endpoint) => endpoint.endsWith("/pulls/7") ? pull() : pages[/&page=(\d+)/.exec(endpoint)![1]!] ?? [])
    const first = await executeGitHubIntegration({ integration: "github", operation: "pullReview", number: 7 }, context, deps)
    expect(first).toMatchObject({ repository: "acme/app", host: "github.com", baseSha: base, headSha: head, totalFiles: 65, page: 1, nextPage: 2, filesCapped: false })
    expect(deps.githubApi).toHaveBeenCalledWith(expect.anything(), "repos/acme/app/pulls/7/files?per_page=30&page=1", expect.anything())
    const last = await executeGitHubIntegration({ integration: "github", operation: "pullReview", number: 7, page: 3 }, context, deps) as unknown as { files: Array<Record<string, unknown>>; nextPage: number | null }
    expect(last.nextPage).toBeNull()
    expect(last.files.map((entry) => [entry.path, entry.patchState])).toEqual([["logo.png", "binary"], ["src/file-61.ts", "too-large"], ["src/file-62.ts", "text"], ["src/file-63.ts", "too-large"], ["src/file-64.ts", "text"]])
    expect(last.files[2]).toMatchObject({ previousPath: "old.ts", patch: "" })
  })

  it("refuses a page read while the head moved", async () => {
    let reads = 0
    const { deps, context } = fixture((endpoint) => endpoint.endsWith("/pulls/7") ? pull(reads++ === 0 ? head : moved) : [file(1)])
    await expect(executeGitHubIntegration({ integration: "github", operation: "pullReview", number: 7 }, context, deps)).rejects.toMatchObject({ status: 409, code: "stale_head" })
  })

  it("says when GitHub caps the listing at 3000 files", async () => {
    const { deps, context } = fixture((endpoint) => endpoint.endsWith("/pulls/7") ? pull(head, 3200) : [file(1)])
    await expect(executeGitHubIntegration({ integration: "github", operation: "pullReview", number: 7, page: 100 }, context, deps)).resolves.toMatchObject({ filesCapped: true, nextPage: null })
  })

  it("keeps an unchanged binary file patchless", () => {
    expect(parseReviewFile({ filename: "a.bin", status: "modified", additions: 0, deletions: 0, changes: 0, sha: "1".repeat(40) })).toMatchObject({ patch: null, patchState: "binary" })
  })
})

describe("explicit review submission", () => {
  const submission = { integration: "github" as const, operation: "submitReview" as const, number: 7, headSha: head, submissionId: "sub_0123456789", body: "Looks close", comments: [{ path: "src/a.ts", side: "RIGHT" as const, line: 3, body: "Rename this" }] }

  it("posts one review on the pinned head with a marker, exactly the given comments", async () => {
    const { deps, context } = fixture((endpoint) => endpoint.endsWith("/pulls/7") ? pull() : [])
    await expect(executeGitHubIntegration(submission, context, deps)).resolves.toMatchObject({ outcome: "submitted", reviewId: 99, headSha: head })
    expect(deps.githubPost).toHaveBeenCalledWith(expect.anything(), "repos/acme/app/pulls/7/reviews", {
      commit_id: head, event: "COMMENT", body: "Looks close\n\n<!-- cogpit-review-submission:sub_0123456789 -->",
      comments: [{ path: "src/a.ts", side: "RIGHT", line: 3, body: "Rename this" }],
    }, expect.anything())
  })

  it("posts nothing on a moved head", async () => {
    const { deps, context } = fixture((endpoint) => endpoint.endsWith("/pulls/7") ? pull(moved) : [])
    await expect(executeGitHubIntegration(submission, context, deps)).resolves.toMatchObject({ outcome: "stale-head", headSha: moved })
    expect(deps.githubPost).not.toHaveBeenCalled()
  })

  it("finds an earlier unconfirmed submission instead of posting it again", async () => {
    const { deps, context } = fixture((endpoint) => endpoint.endsWith("/pulls/7") ? pull(moved)
      : endpoint.includes("page=1") ? [{ id: 5, body: "Other" }, { id: 41, body: "Looks close\n\n<!-- cogpit-review-submission:sub_0123456789 -->", html_url: "https://github.com/acme/app/pull/7#pullrequestreview-41" }] : [])
    await expect(executeGitHubIntegration(submission, context, deps)).resolves.toMatchObject({ outcome: "already-submitted", reviewId: 41 })
    expect(deps.githubPost).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === "win32")("reports a post GitHub never confirmed as unknown, and a refusal as definite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cogpit-github-review-"))
    vi.stubEnv("PATH", `${directory}${delimiter}${dirname(process.execPath)}`)
    const repository = { host: "github.com", owner: "acme", name: "app" }
    try {
      await writeFile(join(directory, "gh"), `#!/usr/bin/env node\nprocess.stderr.write("gh: Server Error (HTTP 502)\\n")\nprocess.exit(1)\n`, { mode: 0o700 })
      await expect(runGitHubPost(repository, "repos/acme/app/pulls/7/reviews", {})).rejects.toMatchObject({ code: "unknown_outcome" })
      await writeFile(join(directory, "gh"), `#!/usr/bin/env node\nprocess.stderr.write("gh: Unprocessable Entity (HTTP 422)\\n")\nprocess.exit(1)\n`, { mode: 0o700 })
      await expect(runGitHubPost(repository, "repos/acme/app/pulls/7/reviews", {})).rejects.toMatchObject({ code: "github_api_failed", status: 422 })
      await writeFile(join(directory, "gh"), `#!/usr/bin/env node\nlet body = ""; process.stdin.on("data", (chunk) => body += chunk); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ id: 1, echoed: JSON.parse(body) })))\n`, { mode: 0o700 })
      await expect(runGitHubPost(repository, "repos/acme/app/pulls/7/reviews", { event: "COMMENT" })).resolves.toEqual({ id: 1, echoed: { event: "COMMENT" } })
    } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) }
  })
})

// @vitest-environment node
import { createHash } from "node:crypto"
import { mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { RouteError } from "../../lib/routeError"
import {
  normalizeRemoteUrl,
  REPO_KEY_RE,
  sanitizeRepoName,
  snapshotWorkspace,
} from "../../workspaceTransfer/snapshot"
import { cleanupTempDirs, gitOut, makeRepo, repoState, tempDir, writeFiles } from "./gitFixtures"

afterEach(cleanupTempDirs)

describe("snapshotWorkspace", () => {
  it("returns HEAD itself for a clean tree", async () => {
    const repo = await makeRepo({ "README.md": "hello\n", "src/lib/a.ts": "a\n" })
    const head = await gitOut(repo, ["rev-parse", "HEAD"])

    const snapshot = await snapshotWorkspace(repo)

    expect(snapshot).toMatchObject({ repoRoot: repo, subdir: "", head, branch: "main", snapshot: head, dirty: false })
    expect(await snapshotWorkspace(join(repo, "src", "lib"))).toMatchObject({ subdir: "src/lib", repoRoot: repo })
  })

  it("reports a detached HEAD as a null branch", async () => {
    const repo = await makeRepo({ "a.txt": "a\n" })
    await gitOut(repo, ["checkout", "-q", "--detach"])

    expect((await snapshotWorkspace(repo)).branch).toBeNull()
  })

  it("commits staged, unstaged and untracked changes but not ignored files, leaving the index alone", async () => {
    const repo = await makeRepo({
      ".gitignore": "*.log\n",
      "staged.txt": "one\n",
      "unstaged.txt": "one\n",
      "deleted.txt": "gone soon\n",
      "partly.txt": "one\n",
    })
    const head = await gitOut(repo, ["rev-parse", "HEAD"])
    await writeFiles(repo, { "staged.txt": "two\n", "partly.txt": "two\n" })
    await gitOut(repo, ["add", "staged.txt", "partly.txt"])
    await writeFiles(repo, {
      "partly.txt": "three\n",
      "unstaged.txt": "two\n",
      "new/untracked.txt": "fresh\n",
      "debug.log": "ignored\n",
    })
    await rm(join(repo, "deleted.txt"))
    const before = await repoState(repo)

    const snapshot = await snapshotWorkspace(repo)

    expect(snapshot.dirty).toBe(true)
    expect(snapshot.head).toBe(head)
    expect(snapshot.snapshot).not.toBe(head)
    expect(await gitOut(repo, ["rev-parse", `${snapshot.snapshot}^`])).toBe(head)
    expect(await gitOut(repo, ["show", `${snapshot.snapshot}:staged.txt`])).toBe("two")
    expect(await gitOut(repo, ["show", `${snapshot.snapshot}:partly.txt`])).toBe("three")
    expect(await gitOut(repo, ["show", `${snapshot.snapshot}:unstaged.txt`])).toBe("two")
    expect(await gitOut(repo, ["show", `${snapshot.snapshot}:new/untracked.txt`])).toBe("fresh")
    expect(await gitOut(repo, ["ls-tree", "-r", "--name-only", snapshot.snapshot])).toBe(
      [".gitignore", "new/untracked.txt", "partly.txt", "staged.txt", "unstaged.txt"].join("\n"),
    )
    expect(await gitOut(repo, ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s", snapshot.snapshot])).toBe(
      "Cogpit <cogpit@localhost>|Cogpit <cogpit@localhost>|Cogpit snapshot: uncommitted changes",
    )

    expect(await repoState(repo)).toEqual(before)
    const gitDir = await readdir(join(repo, ".git"))
    expect(gitDir.filter((name) => name.startsWith("index"))).toEqual(["index"])
  })

  it("catches a same-size edit made in the second the index was written, snapshotted a second later", async () => {
    // Commit and edit inside one wall-clock second, so the index entry and the
    // edit share an mtime second and only git's racy-clean check tells them apart.
    let repo: string
    let second: number
    do {
      second = Math.floor(Date.now() / 1000)
      repo = await makeRepo({ "index.ts": "export const version = 2\n" })
      await writeFiles(repo, { "index.ts": "export const version = 3\n" })
    } while (Math.floor(Date.now() / 1000) !== second)
    await new Promise((resolve) => setTimeout(resolve, (second + 1) * 1000 - Date.now() + 50))

    const snapshot = await snapshotWorkspace(repo)

    expect(snapshot.dirty).toBe(true)
    expect(await gitOut(repo, ["show", `${snapshot.snapshot}:index.ts`])).toBe("export const version = 3")
  })

  it("makes the same commit for the same uncommitted work, whenever it runs", async () => {
    const repo = await makeRepo({ "a.txt": "1\n" })
    await writeFiles(repo, { "a.txt": "2\n" })
    const first = await snapshotWorkspace(repo)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect((await snapshotWorkspace(repo)).snapshot).toBe(first.snapshot)
  })

  it("rejects folders outside a repository and repositories without commits", async () => {
    const plain = await tempDir("cogpit-plain-")
    await expect(snapshotWorkspace(plain)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not inside a git repository/) })

    const unborn = join(await tempDir("cogpit-unborn-"), "repo")
    await mkdir(unborn)
    await gitOut(unborn, ["init", "-q"])
    const failure = await snapshotWorkspace(unborn).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(RouteError)
    expect((failure as RouteError).message).toMatch(/commit at least once before sending this repo to another machine/)

    await expect(snapshotWorkspace(join(plain, "missing"))).rejects.toMatchObject({ status: 400 })
  })

  it("keys a repository by its origin however the URL is spelled", async () => {
    const repo = await makeRepo({ "a.txt": "a\n" }, "local-folder-name")
    await gitOut(repo, ["remote", "add", "origin", "https://user:s3cret@GitHub.com/Owner/My-Repo.git"])

    const snapshot = await snapshotWorkspace(repo)

    const hash = createHash("sha256").update("github.com/Owner/My-Repo").digest("hex").slice(0, 10)
    expect(snapshot.repoName).toBe("my-repo")
    expect(snapshot.repoKey).toBe(`my-repo-${hash}`)
    expect(snapshot.repoKey).toMatch(REPO_KEY_RE)

    await gitOut(repo, ["remote", "set-url", "origin", "git@github.com:Owner/My-Repo.git"])
    expect((await snapshotWorkspace(repo)).repoKey).toBe(snapshot.repoKey)
  })

  it("falls back to the root commit when there is no origin", async () => {
    const first = await makeRepo({ "a.txt": "a\n" }, "proj")
    const copy = join(await tempDir("cogpit-copy-"), "proj")
    await gitOut(first, ["clone", "-q", first, copy])
    await gitOut(copy, ["remote", "remove", "origin"])
    const root = await gitOut(first, ["rev-list", "--max-parents=0", "HEAD"])

    const snapshot = await snapshotWorkspace(first)

    expect(snapshot.repoKey).toBe(`proj-${root.slice(0, 10)}`)
    expect((await snapshotWorkspace(copy)).repoKey).toBe(snapshot.repoKey)
  })
})

describe("repository identity helpers", () => {
  it("normalizes every spelling of one remote to the same string", () => {
    const spellings = [
      "git@github.com:a/b.git",
      "ssh://git@github.com/a/b",
      "ssh://git@github.com/a/b.git/",
      "https://github.com/a/b",
      "https://token:x-oauth@GITHUB.com/a/b.git",
      "git+ssh://git@github.com/a/b.git",
    ]
    expect(new Set(spellings.map(normalizeRemoteUrl))).toEqual(new Set(["github.com/a/b"]))
    expect(normalizeRemoteUrl("https://github.com/a/c")).not.toBe("github.com/a/b")
  })

  it("sanitizes repository names into safe key prefixes", () => {
    expect(sanitizeRepoName("My Repo!")).toBe("my-repo-")
    expect(sanitizeRepoName("..hidden")).toBe("hidden")
    expect(sanitizeRepoName("***")).toBe("repo")
    expect(`${sanitizeRepoName("..")}-0123456789`).toMatch(REPO_KEY_RE)
  })
})

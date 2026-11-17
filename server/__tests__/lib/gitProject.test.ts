// @vitest-environment node
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runGit } from "../../lib/gitProject"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("runGit", () => {
  it("leaves .git/index alone so an agent's concurrent git add cannot hit index.lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "cogpit-git-"))
    roots.push(root)
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root })
    git("init", "-q")
    writeFileSync(join(root, "tracked.txt"), "one\n")
    git("add", "tracked.txt")
    git("commit", "-q", "-m", "initial")
    // A stat change without a content change is what makes `git status` rewrite the index.
    const earlier = new Date(Date.now() - 3_600_000)
    utimesSync(join(root, "tracked.txt"), earlier, earlier)
    const before = readFileSync(join(root, ".git", "index"))

    await runGit(root, ["status", "--porcelain"])

    expect(readFileSync(join(root, ".git", "index")).equals(before)).toBe(true)
  })
})

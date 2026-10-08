// @vitest-environment node
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { findCheckout, matchIdentity, parseIdentity } from "../../workspaceTransfer/projects"
import { snapshotWorkspace } from "../../workspaceTransfer/snapshot"
import { cleanupTempDirs, gitOut, makeRepo, tempDir } from "./gitFixtures"

afterEach(cleanupTempDirs)

describe("matching target checkouts", () => {
  it("matches credential-free normalized origin rather than the folder name", async () => {
    const caller = await makeRepo({ "README.md": "one" }, "caller")
    await gitOut(caller, ["remote", "add", "origin", "https://user:SECRET@github.com/acme/app.git"])
    const target = join(await tempDir("cogpit-clone-"), "different-folder")
    await gitOut(caller, ["clone", "-q", caller, target])
    await gitOut(target, ["remote", "set-url", "origin", "git@github.com:acme/app.git"])
    const identity = (await snapshotWorkspace(caller)).identity
    expect(JSON.stringify(identity)).not.toContain("SECRET")
    expect(await findCheckout(identity, [target, join(target, "..", "missing")])).toEqual({ checkout: target, match: "origin" })
    const worktree = join(await tempDir("cogpit-project-worktree-"), "task")
    await gitOut(target, ["worktree", "add", "-q", "-b", "task", worktree, "HEAD"])
    expect(await findCheckout(identity, [worktree, target])).toEqual({ checkout: target, match: "origin" })
  })

  it("uses roots without an origin, refuses forks with conflicting origins", async () => {
    const caller = await makeRepo({ "README.md": "two" })
    const clone = join(await tempDir("cogpit-roots-"), "renamed")
    await gitOut(caller, ["clone", "-q", caller, clone])
    await gitOut(clone, ["remote", "remove", "origin"])
    const identity = (await snapshotWorkspace(caller)).identity
    expect(await findCheckout(identity, [clone])).toEqual({ checkout: clone, match: "roots" })
    expect(matchIdentity({ ...identity, origin: "github.com/acme/app" }, { ...identity, origin: "github.com/other/fork" })).toBeNull()
    expect(matchIdentity(identity, { roots: ["f".repeat(40)] })).toBeNull()
  })

  it("reports ambiguity and requires an explicit checkout to match identity", async () => {
    const caller = await makeRepo({ "README.md": "three" })
    const identity = (await snapshotWorkspace(caller)).identity
    const clone = join(await tempDir("cogpit-ambiguous-"), "copy")
    await gitOut(caller, ["clone", "-q", caller, clone])
    await gitOut(clone, ["remote", "remove", "origin"])
    expect(await findCheckout(identity, [caller, clone])).toEqual({ match: "ambiguous" })
    expect(await findCheckout(identity, [caller, clone], clone)).toEqual({ checkout: clone, match: "roots" })
    const other = await makeRepo({ "README.md": "unrelated" })
    await expect(findCheckout(identity, [], other)).rejects.toMatchObject({ status: 409 })
    expect(await findCheckout(identity, [other])).toEqual({ match: "none" })
    expect(() => parseIdentity({ origin: "https://user:SECRET@host/a", roots: identity.roots })).toThrow("Invalid repository identity")
  })
})

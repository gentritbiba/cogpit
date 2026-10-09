// @vitest-environment node
import { readFile, stat, symlink } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { decodeEnvironment, encodeEnvironment, installEnvironment, selectEnvironment } from "../../workspaceTransfer/environment"
import { cleanupTempDirs, gitOut, makeRepo, tempDir, writeFiles } from "./gitFixtures"

afterEach(cleanupTempDirs)

describe("ignored environment selection", () => {
  it("selects only ignored env files at the root and in packages", async () => {
    const repo = await makeRepo({ ".gitignore": ".env*\n.dev.vars*\nsecret.json\nnode_modules/\n", "tracked.env": "example" })
    await writeFiles(repo, { ".env": "ROOT_SECRET=sentinel", ".env.local": "LOCAL=1", "apps/web/.dev.vars": "WORKER=2", "secret.json": "PRIVATE", "other.txt": "public", "node_modules/dependency/.env": "dependency-example" })
    expect((await selectEnvironment(repo)).map((file) => file.path)).toEqual([".env", ".env.local", "apps/web/.dev.vars"])
    await writeFiles(repo, { ".cogpit/workspace.json": JSON.stringify({ envFiles: ["secret.json"] }) })
    expect((await selectEnvironment(repo)).map((file) => file.path)).toEqual(["secret.json"])
    expect((await selectEnvironment(repo, ["**/.env.local"])).map((file) => file.path)).toEqual([".env.local"])
    expect(await selectEnvironment(repo, [])).toEqual([])
  })

  it("skips tracked and nonignored files even with an explicit selection", async () => {
    const repo = await makeRepo({ ".env.example": "EXAMPLE=1", ".gitignore": ".env.local\n" })
    await writeFiles(repo, { ".env.local": "SECRET", ".env": "not ignored" })
    expect((await selectEnvironment(repo, ["**/.env*"])).map((file) => file.path)).toEqual([".env.local"])
    await gitOut(repo, ["add", "-f", ".env.local"])
    expect(await selectEnvironment(repo)).toEqual([])
  })

  it("rejects symlinks and unsafe config without exposing secret bytes", async () => {
    const repo = await makeRepo({ ".gitignore": ".env\n" })
    const outside = await tempDir("cogpit-env-outside-")
    await writeFiles(outside, { "credentials": "DO_NOT_EXPOSE_THIS_VALUE" })
    await symlink(join(outside, "credentials"), join(repo, ".env"))
    await expect(selectEnvironment(repo)).rejects.toThrow("Could not provision workspace environment")
    await writeFiles(repo, { ".cogpit/workspace.json": '{"envFiles":["../DO_NOT_EXPOSE_THIS_VALUE"]}' })
    try { await selectEnvironment(repo) } catch (error) { expect(String(error)).not.toContain("DO_NOT_EXPOSE_THIS_VALUE") }
  })

  it("round-trips binary bytes, writes 0600 and keeps them ignored", async () => {
    const repo = await makeRepo({ "README.md": "app" })
    const bytes = Buffer.from([0, 1, 255, 10, 13])
    const encoded = encodeEnvironment([{ path: "packages/app/.env.local", bytes }])
    const files = decodeEnvironment(encoded)
    expect(await installEnvironment(repo, files)).toEqual(["packages/app/.env.local"])
    expect(await readFile(join(repo, files[0].path))).toEqual(bytes)
    if (process.platform !== "win32") expect((await stat(join(repo, files[0].path))).mode & 0o777).toBe(0o600)
    expect(await gitOut(repo, ["status", "--porcelain"])).toBe("")
    for (const malformed of [encoded.subarray(0, -1), Buffer.from("SECRET"), encodeEnvironment([{ path: "../escape", bytes }])]) {
      expect(() => decodeEnvironment(malformed)).toThrow("Could not provision workspace environment")
    }
  })

  it("never overwrites tracked files or follows a destination symlink", async () => {
    const repo = await makeRepo({ ".env": "tracked example" })
    await expect(installEnvironment(repo, [{ path: ".env", bytes: Buffer.from("SECRET") }])).rejects.toThrow()
    expect(await readFile(join(repo, ".env"), "utf8")).toBe("tracked example")
    const outside = await tempDir("cogpit-env-link-")
    await symlink(outside, join(repo, "linked"))
    await expect(installEnvironment(repo, [{ path: "linked/new/.env", bytes: Buffer.from("SECRET") }])).rejects.toThrow()
    await expect(stat(join(outside, "new"))).rejects.toThrow()
  })
})

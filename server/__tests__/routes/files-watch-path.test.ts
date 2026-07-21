// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { resolveTaskOutputPath } from "../../routes/files-watch"

describe("resolveTaskOutputPath", () => {
  let taskRoot: string
  let outsideRoot: string

  beforeEach(async () => {
    taskRoot = await mkdtemp("/tmp/claude-cogpit-output-")
    outsideRoot = await mkdtemp("/tmp/cogpit-output-outside-")
  })

  afterEach(async () => {
    await Promise.all([
      rm(taskRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ])
  })

  it("accepts existing and not-yet-created files inside a claude temp tree", async () => {
    const existing = join(taskRoot, "task.output")
    await writeFile(existing, "ready")

    await expect(resolveTaskOutputPath(existing)).resolves.toBe(await realpath(existing))
    await expect(resolveTaskOutputPath(join(taskRoot, "future.output"))).resolves.toBe(
      join(await realpath(taskRoot), "future.output"),
    )
  })

  it("rejects lexical paths outside a direct claude-* temp tree", async () => {
    await expect(resolveTaskOutputPath(join(outsideRoot, "task.output"))).resolves.toBeNull()
    await expect(resolveTaskOutputPath("/tmp/claude-/task.output")).resolves.toBeNull()
    await expect(
      resolveTaskOutputPath(join(taskRoot, "..", "..", "etc", "passwd")),
    ).resolves.toBeNull()
  })

  it("rejects file and directory symlinks that escape the allowed temp tree", async () => {
    const outsideFile = join(outsideRoot, "secret.txt")
    await writeFile(outsideFile, "secret")

    const fileLink = join(taskRoot, "file-link.output")
    const directoryLink = join(taskRoot, "directory-link")
    await Promise.all([
      symlink(outsideFile, fileLink),
      symlink(outsideRoot, directoryLink),
    ])

    await expect(resolveTaskOutputPath(fileLink)).resolves.toBeNull()
    await expect(resolveTaskOutputPath(join(directoryLink, "secret.txt"))).resolves.toBeNull()
  })

  it("rejects broken symlinks instead of treating them as future output files", async () => {
    const brokenLink = join(taskRoot, "broken.output")
    await symlink(join(outsideRoot, "missing.output"), brokenLink)

    await expect(resolveTaskOutputPath(brokenLink)).resolves.toBeNull()
  })
})

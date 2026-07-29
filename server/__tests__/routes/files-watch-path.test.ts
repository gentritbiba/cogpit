// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveTaskOutputPath } from "../../routes/files-watch"

// Mirrors the allowlist in files-watch.ts: Windows has no /tmp, so task output
// lives under %TEMP% there.
const TEMP_ROOT = process.platform === "win32" ? tmpdir() : "/tmp"

/** Windows only permits symlink creation under Developer Mode or elevation. */
const canCreateSymlinks = await (async () => {
  const probeDir = await mkdtemp(join(TEMP_ROOT, "cogpit-symlink-probe-"))
  try {
    await symlink(probeDir, join(probeDir, "link"), "dir")
    return true
  } catch {
    return false
  } finally {
    await rm(probeDir, { recursive: true, force: true })
  }
})()

describe("resolveTaskOutputPath", () => {
  let taskRoot: string
  let outsideRoot: string

  beforeEach(async () => {
    taskRoot = await mkdtemp(join(TEMP_ROOT, "claude-cogpit-output-"))
    outsideRoot = await mkdtemp(join(TEMP_ROOT, "cogpit-output-outside-"))
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
    await expect(resolveTaskOutputPath(join(TEMP_ROOT, "claude-", "task.output"))).resolves.toBeNull()
    await expect(
      resolveTaskOutputPath(join(taskRoot, "..", "..", "etc", "passwd")),
    ).resolves.toBeNull()
  })

  it.skipIf(!canCreateSymlinks)(
    "rejects file and directory symlinks that escape the allowed temp tree",
    async () => {
      const outsideFile = join(outsideRoot, "secret.txt")
      await writeFile(outsideFile, "secret")

      const fileLink = join(taskRoot, "file-link.output")
      const directoryLink = join(taskRoot, "directory-link")
      await Promise.all([
        symlink(outsideFile, fileLink, "file"),
        symlink(outsideRoot, directoryLink, "dir"),
      ])

      await expect(resolveTaskOutputPath(fileLink)).resolves.toBeNull()
      await expect(resolveTaskOutputPath(join(directoryLink, "secret.txt"))).resolves.toBeNull()
    },
  )

  it.skipIf(!canCreateSymlinks)(
    "rejects broken symlinks instead of treating them as future output files",
    async () => {
      const brokenLink = join(taskRoot, "broken.output")
      await symlink(join(outsideRoot, "missing.output"), brokenLink, "file")

      await expect(resolveTaskOutputPath(brokenLink)).resolves.toBeNull()
    },
  )
})

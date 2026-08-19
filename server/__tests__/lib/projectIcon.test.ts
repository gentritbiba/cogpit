import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { resolveProjectIcon, iconContentType } from "../../lib/projectIcon"

let root = ""

/** Returns the canonical path, which is what the resolver reports. */
async function put(relativePath: string, contents = "x") {
  const full = join(root, relativePath)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, contents)
  return realpath(full)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogpit-icon-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("resolveProjectIcon", () => {
  it("finds an icon at the repository root", async () => {
    const icon = await put("favicon.svg")

    await expect(resolveProjectIcon(root)).resolves.toBe(icon)
  })

  it("finds icons kept in the usual asset directories", async () => {
    const icon = await put("public/favicon.ico")

    await expect(resolveProjectIcon(root)).resolves.toBe(icon)
  })

  it("prefers a root icon over one buried in a subdirectory", async () => {
    await put("public/favicon.ico")
    const preferred = await put("favicon.svg")

    await expect(resolveProjectIcon(root)).resolves.toBe(preferred)
  })

  it("finds a logo named after the project", async () => {
    // Repositories often name the mark after themselves rather than "favicon";
    // this project ships public/cogpit.svg.
    const project = join(root, "cogpit")
    await mkdir(join(project, "public"), { recursive: true })
    await writeFile(join(project, "public", "cogpit.svg"), "x")

    await expect(resolveProjectIcon(project)).resolves.toBe(
      await realpath(join(project, "public", "cogpit.svg")),
    )
  })

  it("does not mistake a same-named file in public for an icon", async () => {
    const project = join(root, "notes")
    await mkdir(join(project, "public"), { recursive: true })
    await writeFile(join(project, "public", "notes.txt"), "x")

    await expect(resolveProjectIcon(project)).resolves.toBeNull()
  })

  it("finds an electron-builder application icon", async () => {
    const icon = await put("build/icon.png")

    await expect(resolveProjectIcon(root)).resolves.toBe(icon)
  })

  it("returns nothing for a project with no icon", async () => {
    await put("README.md")

    await expect(resolveProjectIcon(root)).resolves.toBeNull()
  })

  it("ignores a directory that happens to be named like an icon", async () => {
    await mkdir(join(root, "favicon.svg"), { recursive: true })

    await expect(resolveProjectIcon(root)).resolves.toBeNull()
  })

  it("refuses an icon symlinked outside the project", async () => {
    const outside = await mkdtemp(join(tmpdir(), "cogpit-outside-"))
    await writeFile(join(outside, "secret.svg"), "x")
    await symlink(join(outside, "secret.svg"), join(root, "favicon.svg"))

    await expect(resolveProjectIcon(root)).resolves.toBeNull()

    await rm(outside, { recursive: true, force: true })
  })

  it("refuses a file too large to be an icon", async () => {
    await put("favicon.png", "x".repeat(3 * 1024 * 1024))

    await expect(resolveProjectIcon(root)).resolves.toBeNull()
  })
})

describe("iconContentType", () => {
  it("maps the formats a project icon can take", () => {
    expect(iconContentType("/a/favicon.svg")).toBe("image/svg+xml")
    expect(iconContentType("/a/favicon.ico")).toBe("image/x-icon")
    expect(iconContentType("/a/icon.png")).toBe("image/png")
  })

  it("refuses anything it cannot name", () => {
    expect(iconContentType("/a/icon.exe")).toBeNull()
  })
})

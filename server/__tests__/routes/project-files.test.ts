// @vitest-environment node
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { rankProjectFiles } from "../../routes/project-files-ranking"
import { listProjectFiles } from "../../routes/project-files"

const execFile = promisify(execFileCallback)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("rankProjectFiles", () => {
  const files = [
    "src/components/Button.tsx",
    "src/components/Button.test.tsx",
    "src/lib/button-utils.ts",
    "README.md",
  ]

  it("prioritizes basename prefixes and respects the result limit", () => {
    expect(rankProjectFiles(files, "button", 2)).toEqual([
      "src/components/Button.tsx",
      "src/components/Button.test.tsx",
    ])
  })

  it("supports multi-term path filtering", () => {
    expect(rankProjectFiles(files, "src utils", 10)).toEqual([
      "src/lib/button-utils.ts",
    ])
  })
})

describe("listProjectFiles", () => {
  it("uses git-aware listing so ignored files stay out of suggestions", async () => {
    const root = await mkdtemp(join(tmpdir(), "cogpit-project-list-git-"))
    temporaryDirectories.push(root)
    await execFile("git", ["init"], { cwd: root })
    await writeFile(join(root, ".gitignore"), "ignored.log\n", "utf-8")
    await writeFile(join(root, "visible.ts"), "export {}\n", "utf-8")
    await writeFile(join(root, "ignored.log"), "noise\n", "utf-8")

    expect(await listProjectFiles(root)).toEqual([".gitignore", "visible.ts"])
  })

  it("falls back to the bounded filesystem walker outside git repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "cogpit-project-list-files-"))
    temporaryDirectories.push(root)
    await mkdir(join(root, "src"))
    await mkdir(join(root, "node_modules"))
    await writeFile(join(root, "src", "app.ts"), "export {}\n", "utf-8")
    await writeFile(join(root, "node_modules", "ignored.js"), "", "utf-8")

    expect(await listProjectFiles(root)).toEqual(["src/app.ts"])
  })
})

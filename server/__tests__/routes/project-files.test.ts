// @vitest-environment node
import { execFile as execFileCallback } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../../helpers"
import { rankProjectFiles } from "../../routes/project-files-ranking"
import { listDirectoryEntries, listProjectFiles, registerProjectFileRoutes } from "../../routes/project-files"

const execFile = promisify(execFileCallback)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function getHandler(route: string): Middleware {
  let handler: Middleware | undefined
  const use: UseFn = (path, candidate) => {
    if (path === route) handler = candidate
  }
  registerProjectFileRoutes(use)
  if (!handler) throw new Error(`${route} was not registered`)
  return handler
}

async function callRoute<T>(route: string, query: string) {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string }
  req.method = "GET"
  req.url = `${route}?${query}`
  let responseBody = ""
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((value?: string) => { responseBody = value ?? "" }),
  }
  await getHandler(route)(req as never, res as never, vi.fn())
  return { status: res.statusCode, data: JSON.parse(responseBody) as T }
}

function listViaRoute(query: string) {
  return callRoute<{ files: string[]; totalMatches: number; scanLimited: boolean }>("/api/project-files", query)
}

function treeViaRoute(query: string) {
  return callRoute<{ entries?: { name: string; type: string }[]; error?: string }>("/api/project-files/tree", query)
}

describe("rankProjectFiles", () => {
  const files = [
    "src/components/Button.tsx",
    "src/components/Button.test.tsx",
    "src/lib/button-utils.ts",
    "README.md",
  ]

  it("prioritizes basename prefixes and respects the result limit", () => {
    expect(rankProjectFiles(files, "button", 2).files).toEqual([
      "src/components/Button.tsx",
      "src/components/Button.test.tsx",
    ])
  })

  it("supports multi-term path filtering", () => {
    expect(rankProjectFiles(files, "src utils", 10).files).toEqual([
      "src/lib/button-utils.ts",
    ])
  })

  it("reports how many files matched before the limit was applied", () => {
    expect(rankProjectFiles(files, "button", 2).totalMatches).toBe(3)
    expect(rankProjectFiles(files, "button", 10).totalMatches).toBe(3)
    expect(rankProjectFiles(files, "", 2).totalMatches).toBe(4)
    expect(rankProjectFiles(files, "nothing-matches", 10).totalMatches).toBe(0)
  })
})

describe("listDirectoryEntries", () => {
  const files = [
    "src/components/Button.tsx",
    "src/components/ui/dialog.tsx",
    "src/index.ts",
    "README.md",
    ".gitignore",
  ]

  it("lists the root with directories first", () => {
    expect(listDirectoryEntries(files, "")).toEqual([
      { name: "src", type: "directory" },
      { name: ".gitignore", type: "file" },
      { name: "README.md", type: "file" },
    ])
  })

  it("lists only the direct children of a nested directory", () => {
    expect(listDirectoryEntries(files, "src/components")).toEqual([
      { name: "ui", type: "directory" },
      { name: "Button.tsx", type: "file" },
    ])
    expect(listDirectoryEntries(files, "src/components/")).toEqual(listDirectoryEntries(files, "src/components"))
  })

  it("collapses single-child directory chains into one entry", () => {
    expect(listDirectoryEntries(["packages/app/src/index.ts", "packages/app/src/lib/a.ts", "top.ts"], "")).toEqual([
      { name: "packages/app/src", type: "directory" },
      { name: "top.ts", type: "file" },
    ])
    expect(listDirectoryEntries(["packages/app/src/index.ts", "packages/app/src/lib/a.ts"], "packages/app/src")).toEqual([
      { name: "lib", type: "directory" },
      { name: "index.ts", type: "file" },
    ])
  })

  it("does not treat a sibling directory with a shared prefix as a child", () => {
    expect(listDirectoryEntries(["src/a.ts", "src-legacy/b.ts"], "src")).toEqual([{ name: "a.ts", type: "file" }])
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

  it("re-reads the directory when the caller asks to skip the cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "cogpit-project-list-refresh-"))
    temporaryDirectories.push(root)
    await writeFile(join(root, "first.ts"), "export {}\n", "utf-8")

    expect(await listProjectFiles(root)).toEqual(["first.ts"])
    await writeFile(join(root, "second.ts"), "export {}\n", "utf-8")

    expect(await listProjectFiles(root)).toEqual(["first.ts"])
    expect(await listProjectFiles(root, { skipCache: true })).toEqual(["first.ts", "second.ts"])
    expect(await listProjectFiles(root)).toEqual(["first.ts", "second.ts"])
  })
})

describe("project files route", () => {
  async function createProject(fileCount: number) {
    const root = await mkdtemp(join(tmpdir(), "cogpit-project-files-route-"))
    temporaryDirectories.push(root)
    for (let index = 0; index < fileCount; index += 1) {
      await writeFile(join(root, `widget-${index}.ts`), "export {}\n", "utf-8")
    }
    return root
  }

  it("reports the full match count so the client can tell when results were cut", async () => {
    const root = await createProject(5)
    const cut = await listViaRoute(`cwd=${encodeURIComponent(root)}&q=widget&limit=2`)

    expect(cut.status).toBe(200)
    expect(cut.data.files).toHaveLength(2)
    expect(cut.data.totalMatches).toBe(5)
    expect(cut.data.scanLimited).toBe(false)
  })

  it("reports every match when the limit is not reached", async () => {
    const root = await createProject(3)
    const complete = await listViaRoute(`cwd=${encodeURIComponent(root)}&q=widget&limit=100`)

    expect(complete.data.files).toHaveLength(3)
    expect(complete.data.totalMatches).toBe(3)
  })

  it("skips the listing cache when refresh is requested", async () => {
    const root = await createProject(1)
    const cwd = encodeURIComponent(root)

    expect((await listViaRoute(`cwd=${cwd}&limit=100`)).data.files).toEqual(["widget-0.ts"])
    await writeFile(join(root, "widget-1.ts"), "export {}\n", "utf-8")

    expect((await listViaRoute(`cwd=${cwd}&limit=100`)).data.files).toEqual(["widget-0.ts"])
    expect((await listViaRoute(`cwd=${cwd}&limit=100&refresh=1`)).data.files)
      .toEqual(["widget-0.ts", "widget-1.ts"])
  })

  it("lists one directory of the tree at a time", async () => {
    const root = await mkdtemp(join(tmpdir(), "cogpit-project-tree-route-"))
    temporaryDirectories.push(root)
    await mkdir(join(root, "src", "lib"), { recursive: true })
    await writeFile(join(root, "src", "lib", "util.ts"), "export {}\n", "utf-8")
    await writeFile(join(root, "src", "main.ts"), "export {}\n", "utf-8")
    await writeFile(join(root, "README.md"), "# Hi\n", "utf-8")
    const cwd = encodeURIComponent(root)

    expect((await treeViaRoute(`cwd=${cwd}`)).data.entries).toEqual([
      { name: "src", type: "directory" },
      { name: "README.md", type: "file" },
    ])
    expect((await treeViaRoute(`cwd=${cwd}&dir=src`)).data.entries).toEqual([
      { name: "lib", type: "directory" },
      { name: "main.ts", type: "file" },
    ])
  })

  it("rejects tree directories that escape the project", async () => {
    const root = await createProject(1)
    const response = await treeViaRoute(`cwd=${encodeURIComponent(root)}&dir=../outside`)

    expect(response.status).toBe(400)
    expect(response.data.error).toMatch(/inside the project/)
  })
})

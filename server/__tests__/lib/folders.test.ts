// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { access, chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, parse } from "node:path"
import { FOLDER_LISTING_LIMIT } from "../../../shared/contracts/folders"
import { absoluteFolderPath, createFolder, listFolder, sessionFolderProblem } from "../../lib/folders"
import { RouteError } from "../../lib/routeError"

const POSIX = process.platform !== "win32"
/** Root reads through any mode bits, so a permission refusal cannot be staged as root. */
const CAN_LOCK = POSIX && process.getuid?.() !== 0

let root: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogpit-folders-"))
  outside = await mkdtemp(join(tmpdir(), "cogpit-folders-outside-"))
})

afterEach(async () => {
  delete process.env.COGPIT_PROJECTS_ROOT
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

async function refusalOf(pending: Promise<unknown> | (() => unknown)) {
  const error = await Promise.resolve()
    .then(() => (typeof pending === "function" ? pending() : pending))
    .then(() => null, (thrown: unknown) => thrown)
  expect(error).toBeInstanceOf(RouteError)
  const { status, code, message } = error as RouteError
  return { status, code, message }
}

async function makeFolders(...names: string[]): Promise<void> {
  await Promise.all(names.map((name) => mkdir(join(root, name))))
}

const names = async (path = root) => (await listFolder(path)).folders.map((folder) => folder.name)

/** Making a thousand folders takes a busy CI disk longer than the default test timeout. */
const MANY_FOLDERS_MS = 30_000

/** The `i`th of many folders, named so that they sort in order. */
const numbered = (i: number) => `f${String(i).padStart(4, "0")}`
const manyFolders = (count: number) => Array.from({ length: count }, (_, i) => numbered(i))

describe("listFolder", () => {
  it("lists subfolders by name ignoring case, leaving out files and hidden folders", async () => {
    await makeFolders("beta", "Alpha", "gamma", ".git", ".cache")
    await writeFile(join(root, "README.md"), "")

    const listing = await listFolder(root)

    expect(listing).toEqual({
      path: root,
      parent: dirname(root),
      root: expect.any(String),
      confined: false,
      folders: ["Alpha", "beta", "gamma"].map((name) => ({ name, path: join(root, name) })),
      truncated: false,
    })
  })

  it("orders numbered names the way people count", async () => {
    await makeFolders("step10", "step2", "step1")
    expect(await names()).toEqual(["step1", "step2", "step10"])
  })

  it("lists the path it was given in normal form", async () => {
    await makeFolders("inner")
    expect((await listFolder(join(root, "inner", ".."))).path).toBe(root)
  })

  it.skipIf(!POSIX)("lists a link to a folder, and not a link to a file or to nothing", async () => {
    await makeFolders("real")
    await writeFile(join(root, "notes.txt"), "")
    await symlink(outside, join(root, "linked"))
    await symlink(join(root, "notes.txt"), join(root, "file-link"))
    await symlink(join(root, "gone"), join(root, "dangling"))

    expect(await names()).toEqual(["linked", "real"])
  })

  it("has no parent at the top of the filesystem", async () => {
    const top = parse(root).root
    const listing = await listFolder(top)
    expect(listing.path).toBe(top)
    expect(listing.parent).toBeNull()
  })

  it("names the projects root browsing starts in", async () => {
    process.env.COGPIT_PROJECTS_ROOT = outside
    expect((await listFolder(root)).root).toBe(outside)
  })

  it("stops at the listing limit and says the folder holds more", async () => {
    await makeFolders(...manyFolders(FOLDER_LISTING_LIMIT + 1))

    const listing = await listFolder(root)

    expect(listing.folders).toHaveLength(FOLDER_LISTING_LIMIT)
    expect(listing.folders.at(-1)?.name).toBe(numbered(FOLDER_LISTING_LIMIT - 1))
    expect(listing.truncated).toBe(true)
  }, MANY_FOLDERS_MS)

  it("is not truncated by files and hidden folders past the limit", async () => {
    await makeFolders(...manyFolders(FOLDER_LISTING_LIMIT), ".zz-hidden")
    await writeFile(join(root, "zz-file"), "")

    const listing = await listFolder(root)

    expect(listing.folders).toHaveLength(FOLDER_LISTING_LIMIT)
    expect(listing.truncated).toBe(false)
  }, MANY_FOLDERS_MS)

  it("answers 404 for a folder that does not exist", async () => {
    const missing = join(root, "missing")
    expect(await refusalOf(listFolder(missing))).toEqual({
      status: 404, code: "NOT_FOUND", message: `The folder ${missing} does not exist`,
    })
  })

  it("answers 400 for a file", async () => {
    const file = join(root, "notes.txt")
    await writeFile(file, "")
    expect(await refusalOf(listFolder(file))).toEqual({
      status: 400, code: "INVALID_REQUEST", message: `${file} is not a folder`,
    })
  })

  it.skipIf(!CAN_LOCK)("answers 403 for a folder the server may not read", async () => {
    const locked = join(root, "locked")
    await mkdir(locked)
    await chmod(locked, 0o000)
    try {
      expect(await refusalOf(listFolder(locked))).toEqual({
        status: 403, code: "FORBIDDEN", message: `Cogpit is not allowed to open ${locked}`,
      })
    } finally {
      await chmod(locked, 0o700)
    }
  })
})

describe("absoluteFolderPath", () => {
  it.each([
    ["a relative path", "code/project"],
    ["a path holding NUL", `${join(tmpdir(), "a")}\0b`],
    ["an empty path", ""],
    ["a number", 5],
    ["nothing", undefined],
  ])("refuses %s", async (_label, value) => {
    expect(await refusalOf(() => absoluteFolderPath(value, "path"))).toEqual({
      status: 400, code: "INVALID_REQUEST", message: "path must be an absolute path",
    })
  })

  it("resolves dot segments", () => {
    expect(absoluteFolderPath(join(root, "x", ".."), "parent")).toBe(root)
  })
})

describe("createFolder", () => {
  it("makes one folder and returns its path", async () => {
    const path = await createFolder(root, "new-project")
    expect(path).toBe(join(root, "new-project"))
    await expect(access(path)).resolves.toBeUndefined()
  })

  it("answers 409 for a name already taken, by a folder or a file", async () => {
    await makeFolders("taken")
    await writeFile(join(root, "notes.txt"), "")
    for (const name of ["taken", "notes.txt"]) {
      expect(await refusalOf(createFolder(root, name))).toEqual({
        status: 409, code: "CONFLICT", message: `${name} already exists in ${root}`,
      })
    }
  })

  it.each([
    [".", `"." is not a folder name`],
    ["..", `".." is not a folder name`],
    ["../escape", "A folder name cannot contain / or \\"],
    ["a/b", "A folder name cannot contain / or \\"],
    ["..\\escape", "A folder name cannot contain / or \\"],
    ["a\0b", "A folder name cannot contain control characters"],
    ["tab\there", "A folder name cannot contain control characters"],
    [" padded", "A folder name cannot start or end with a space"],
    ["", "Enter a folder name"],
    ["x".repeat(256), "That folder name is too long"],
    ["é".repeat(128), "That folder name is too long"],
  ])("refuses the name %j without touching the disk", async (name, message) => {
    expect(await refusalOf(createFolder(root, name))).toEqual({ status: 400, code: "INVALID_REQUEST", message })
    expect(await readdir(root)).toEqual([])
    expect(await readdir(dirname(root))).not.toContain("escape")
  })

  it("never makes a missing parent", async () => {
    const missing = join(root, "missing")
    expect(await refusalOf(createFolder(missing, "child"))).toEqual({
      status: 404, code: "NOT_FOUND", message: `The folder ${missing} does not exist`,
    })
    expect(await readdir(root)).toEqual([])
  })

  it("answers 400 for a parent that is a file", async () => {
    const file = join(root, "notes.txt")
    await writeFile(file, "")
    expect(await refusalOf(createFolder(file, "child"))).toEqual({
      status: 400, code: "INVALID_REQUEST", message: `${file} is not a folder`,
    })
  })

  it.skipIf(!CAN_LOCK)("answers 403 in a folder the server may not write", async () => {
    await chmod(root, 0o500)
    try {
      expect(await refusalOf(createFolder(root, "child"))).toEqual({
        status: 403, code: "FORBIDDEN", message: `Cogpit is not allowed to create folders in ${root}`,
      })
    } finally {
      await chmod(root, 0o700)
    }
  })
})

describe("sessionFolderProblem", () => {
  it("passes a folder that exists", async () => {
    expect(await sessionFolderProblem(root)).toBeNull()
  })

  it.skipIf(!POSIX)("passes a link to a folder", async () => {
    await symlink(outside, join(root, "linked"))
    expect(await sessionFolderProblem(join(root, "linked"))).toBeNull()
  })

  it("names a folder that does not exist", async () => {
    const missing = join(root, "deleted")
    expect(await sessionFolderProblem(missing)).toBe(`The folder ${missing} does not exist`)
  })

  it("names a file given as a folder", async () => {
    const file = join(root, "notes.txt")
    await writeFile(file, "")
    expect(await sessionFolderProblem(file)).toBe(`${file} is not a folder`)
    expect(await sessionFolderProblem(join(file, "below"))).toBe(`The folder ${join(file, "below")} does not exist`)
  })
})

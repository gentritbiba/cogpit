// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { writeOwnerOnlyJson, writeOwnerOnlyText } from "../atomicJsonFile"
import { syncDirectory } from "../lib/diskSync"

vi.unmock("../lib/diskSync")

/** What reached the disk, in order: each flush of a file or directory, and each rename. */
const disk = vi.hoisted(() => ({
  events: [] as string[],
  /** The code the next flush of a directory fails with. */
  directoryFailure: null as string | null,
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      for (const method of ["sync", "datasync"] as const) {
        const flush = handle[method].bind(handle)
        handle[method] = async () => {
          const failure = method === "sync" ? disk.directoryFailure : null
          if (failure) {
            disk.directoryFailure = null
            throw Object.assign(new Error(`${failure}: directory flush`), { code: failure })
          }
          disk.events.push(`${method} ${String(args[0])}`)
          return flush()
        }
      }
      return handle
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      disk.events.push(`rename ${basename(String(args[0])).endsWith(".tmp") ? "temporary" : String(args[0])} ${String(args[1])}`)
      return actual.rename(...args)
    },
  }
})

let fixtureDir: string
let filePath: string

beforeEach(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "cogpit-atomic-json-"))
  filePath = join(fixtureDir, "config.json")
  await writeFile(filePath, "old-value", "utf8")
})

afterEach(async () => {
  disk.events = []
  disk.directoryFailure = null
  vi.restoreAllMocks()
  await rm(fixtureDir, { recursive: true, force: true })
})

describe("writeOwnerOnlyJson", () => {
  it("atomically replaces a file and leaves no temporary behind", async () => {
    await writeOwnerOnlyJson(filePath, { current: true })

    await expect(readFile(filePath, "utf8")).resolves.toBe(JSON.stringify({ current: true }, null, 2))
    expect(await readdir(fixtureDir)).toEqual(["config.json"])
  })

  // Windows has no POSIX modes — chmod only toggles the read-only bit there, so
  // a real file can never report 0600.
  it.skipIf(process.platform === "win32")("leaves the replacement owner-only", async () => {
    await writeOwnerOnlyJson(filePath, { current: true })

    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })
})

describe("writeOwnerOnlyText", () => {
  it.skipIf(process.platform === "win32")("gives the replaced file the requested mode", async () => {
    await chmod(filePath, 0o644)

    await writeOwnerOnlyText(filePath, "new-value", 0o640)

    await expect(readFile(filePath, "utf8")).resolves.toBe("new-value")
    expect((await stat(filePath)).mode & 0o777).toBe(0o640)
  })
})

describe("a durable write", () => {
  it("flushes the new bytes before the rename, and the directory's entry after it", async () => {
    await writeOwnerOnlyText(filePath, "new-value", 0o600, { durable: true })

    expect(disk.events).toEqual([
      expect.stringMatching(/^datasync .*\.tmp$/),
      `rename temporary ${filePath}`,
      ...(process.platform === "win32" ? [] : [`sync ${fixtureDir}`]),
    ])
    await expect(readFile(filePath, "utf8")).resolves.toBe("new-value")
  })

  it("is what JSON asks for too, while a plain write flushes nothing", async () => {
    await writeOwnerOnlyJson(filePath, { current: true })
    expect(disk.events).toEqual([`rename temporary ${filePath}`])

    disk.events = []
    await writeOwnerOnlyJson(filePath, { current: true }, 0o600, { durable: true })
    expect(disk.events[0]).toMatch(/^datasync /)
  })
})

// Windows cannot open a directory to flush it, so there is no directory flush to fail.
describe.skipIf(process.platform === "win32")("a directory that cannot be flushed", () => {
  it.each(["EINVAL", "ENOTSUP", "EBADF"])("counts as flushed when the filesystem answers %s, which means it does not support that", async (code) => {
    disk.directoryFailure = code
    await expect(syncDirectory(fixtureDir)).resolves.toBeUndefined()
  })

  it("fails the flush on any other error", async () => {
    disk.directoryFailure = "EIO"
    await expect(syncDirectory(fixtureDir)).rejects.toMatchObject({ code: "EIO" })
  })

  it("does not fail a durable write whose rename landed: the new bytes are in place, and it warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    disk.directoryFailure = "EIO"

    await expect(writeOwnerOnlyText(filePath, "new-value", 0o600, { durable: true })).resolves.toBeUndefined()
    await expect(readFile(filePath, "utf8")).resolves.toBe("new-value")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(filePath), expect.objectContaining({ code: "EIO" }))
  })
})

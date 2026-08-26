// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

type AtomicWrite = typeof import("../../atomicJsonFile").writeOwnerOnlyJson

const atomicWrite = vi.hoisted(() => ({
  implementation: undefined as AtomicWrite | undefined,
}))

vi.mock("../../atomicJsonFile", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../atomicJsonFile")>()
  return {
    ...original,
    writeOwnerOnlyJson: (...args: Parameters<AtomicWrite>) =>
      (atomicWrite.implementation ?? original.writeOwnerOnlyJson)(...args),
  }
})

import {
  initShareRegistry,
  clearAllShares,
  createShare,
  getShareWithHash,
  listShares,
  removeShare,
  rotateSharePassword,
  touchShare,
} from "../../share/registry"
import { verifyPassword } from "../../password-utils"

let dir: string

// Windows has no POSIX modes — chmod only toggles the read-only bit there, so
// a real file can never report 0600.
const POSIX_MODES_UNSUPPORTED = process.platform === "win32"

beforeEach(async () => {
  atomicWrite.implementation = undefined
  dir = await mkdtemp(join(tmpdir(), "cogpit-shares-"))
  await initShareRegistry(dir)
})
afterEach(async () => {
  atomicWrite.implementation = undefined
  await rm(dir, { recursive: true, force: true })
})

const INPUT = { sessionId: "sess-1", dirName: "-Users-me-proj", fileName: "sess-1.jsonl" }

const registryFile = () => join(dir, "shares.local.json")

describe("share registry", () => {
  it("returns the plaintext passphrase exactly once, at creation", async () => {
    const created = await createShare(INPUT)
    expect(created.passphrase).toMatch(/-\d{2}$/)
    const stored = getShareWithHash("sess-1")
    expect(stored).toBeDefined()
    expect(stored).not.toHaveProperty("passphrase")
    expect(verifyPassword(created.passphrase, stored!.passwordHash)).toBe(true)
  })

  it("never persists the plaintext passphrase", async () => {
    const created = await createShare(INPUT)
    const raw = await readFile(registryFile(), "utf-8")
    expect(raw).not.toContain(created.passphrase)
  })

  it.skipIf(POSIX_MODES_UNSUPPORTED)("writes the file owner-only", async () => {
    await createShare(INPUT)
    const info = await stat(registryFile())
    expect(info.mode & 0o777).toBe(0o600)
  })

  it("reloads shares from disk", async () => {
    const created = await createShare(INPUT)
    await initShareRegistry(dir)
    expect(verifyPassword(created.passphrase, getShareWithHash("sess-1")!.passwordHash)).toBe(true)
  })

  it("re-sharing an already shared session replaces the passphrase but keeps createdAt", async () => {
    const first = await createShare(INPUT)
    const second = await createShare(INPUT)
    expect(second.passphrase).not.toBe(first.passphrase)
    expect(listShares()).toHaveLength(1)
    expect(verifyPassword(first.passphrase, getShareWithHash("sess-1")!.passwordHash)).toBe(false)
    expect(second.share.createdAt).toBe(first.share.createdAt)
  })

  it("reports a brand new share as never accessed", async () => {
    const created = await createShare(INPUT)
    expect(created.share.lastAccessAt).toBe(0)

    touchShare("sess-1")
    const reshared = await createShare(INPUT)
    expect(reshared.share.lastAccessAt).toBe(0)
  })

  it("rotates the passphrase in place", async () => {
    const first = await createShare(INPUT)
    const rotated = await rotateSharePassword("sess-1")
    expect(rotated).not.toBeNull()
    expect(verifyPassword(first.passphrase, getShareWithHash("sess-1")!.passwordHash)).toBe(false)
    expect(verifyPassword(rotated!.passphrase, getShareWithHash("sess-1")!.passwordHash)).toBe(true)
  })

  it("rotating an unknown share returns null", async () => {
    expect(await rotateSharePassword("nope")).toBeNull()
  })

  it("removes shares", async () => {
    await createShare(INPUT)
    expect(await removeShare("sess-1")).toBe(true)
    expect(getShareWithHash("sess-1")).toBeUndefined()
    expect(await removeShare("sess-1")).toBe(false)
  })

  it("clears every share in one write", async () => {
    await createShare(INPUT)
    await createShare({ ...INPUT, sessionId: "sess-2", fileName: "sess-2.jsonl" })
    await createShare({ ...INPUT, sessionId: "sess-3", fileName: "sess-3.jsonl" })

    const writes: string[] = []
    atomicWrite.implementation = async (path, data) => {
      writes.push(path)
      await writeFile(path, JSON.stringify(data), { mode: 0o600 })
    }

    await clearAllShares()

    // One rewrite, not one per record: removing them one at a time serializes
    // a whole file write per share for a change that has a single end state.
    expect(writes).toHaveLength(1)
    expect(listShares()).toEqual([])
    expect(JSON.parse(await readFile(registryFile(), "utf-8"))).toEqual([])
  })

  it("does not rewrite the file when there is nothing to clear", async () => {
    const writes: string[] = []
    atomicWrite.implementation = async (path, data) => {
      writes.push(path)
      await writeFile(path, JSON.stringify(data), { mode: 0o600 })
    }

    await clearAllShares()

    expect(writes).toEqual([])
  })

  it("listShares never exposes the hash", async () => {
    await createShare(INPUT)
    expect(listShares()[0]).not.toHaveProperty("passwordHash")
  })

  it("never hands the hash back to the caller that issues a passphrase", async () => {
    const created = await createShare(INPUT)
    expect(created.share).not.toHaveProperty("passwordHash")

    const rotated = await rotateSharePassword("sess-1")
    expect(rotated!.share).not.toHaveProperty("passwordHash")
  })

  it("drops records whose passwordHash is not a recognised hash", async () => {
    await writeFile(registryFile(), JSON.stringify([
      { ...INPUT, sessionId: "empty-hash", passwordHash: "", createdAt: 1, lastAccessAt: 0 },
      { ...INPUT, sessionId: "plaintext", passwordHash: "hunter2", createdAt: 1, lastAccessAt: 0 },
    ]))
    await initShareRegistry(dir)
    expect(listShares()).toHaveLength(0)
  })

  it("refuses to mutate a registry that was never pointed at a file", async () => {
    vi.resetModules()
    const uninitialised = await import("../../share/registry")
    await expect(uninitialised.createShare(INPUT)).rejects.toThrow(/initShareRegistry/)
    expect(uninitialised.listShares()).toHaveLength(0)
  })

  it("starts empty on corrupt JSON instead of throwing", async () => {
    await createShare(INPUT)
    await writeFile(registryFile(), "{not json")
    await initShareRegistry(dir)
    expect(listShares()).toHaveLength(0)
  })

  it("serializes concurrent creates without losing records", async () => {
    await Promise.all([
      createShare({ ...INPUT, sessionId: "a" }),
      createShare({ ...INPUT, sessionId: "b" }),
      createShare({ ...INPUT, sessionId: "c" }),
    ])
    expect(listShares().map((s) => s.sessionId).sort()).toEqual(["a", "b", "c"])
  })

  it("touches lastAccessAt in memory without rewriting the file", async () => {
    await createShare(INPUT)
    const before = getShareWithHash("sess-1")!.lastAccessAt
    const persistedBefore = await readFile(registryFile(), "utf-8")

    const now = vi.spyOn(Date, "now").mockReturnValue(before + 60_000)
    touchShare("sess-1")
    touchShare("never-shared")
    now.mockRestore()

    expect(getShareWithHash("sess-1")!.lastAccessAt).toBe(before + 60_000)
    expect(await readFile(registryFile(), "utf-8")).toBe(persistedBefore)
  })

  it("keeps a guest touch that lands while another share's write is in flight", async () => {
    await createShare(INPUT)
    const touchedAt = 1_770_000_000_000

    let startWrite!: () => void
    let releaseWrite!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      startWrite = resolve
    })
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    atomicWrite.implementation = async () => {
      startWrite()
      await writeGate
    }

    const pending = createShare({ ...INPUT, sessionId: "sess-2" })
    await writeStarted

    const now = vi.spyOn(Date, "now").mockReturnValue(touchedAt)
    touchShare("sess-1")
    now.mockRestore()

    releaseWrite()
    await pending

    expect(getShareWithHash("sess-1")!.lastAccessAt).toBe(touchedAt)
  })

  it("rolls back a failed persist and keeps the queue usable", async () => {
    const created = await createShare(INPUT)
    const failure = new Error("simulated persistence failure")
    atomicWrite.implementation = async () => {
      throw failure
    }

    await expect(rotateSharePassword("sess-1")).rejects.toBe(failure)
    expect(verifyPassword(created.passphrase, getShareWithHash("sess-1")!.passwordHash)).toBe(true)

    await expect(removeShare("sess-1")).rejects.toBe(failure)
    expect(getShareWithHash("sess-1")).toBeDefined()

    atomicWrite.implementation = undefined
    expect(await removeShare("sess-1")).toBe(true)
    expect(listShares()).toHaveLength(0)
  })
})

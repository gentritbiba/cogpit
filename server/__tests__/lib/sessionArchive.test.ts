// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockDirs } = vi.hoisted(() => ({ mockDirs: { SESSION_CONFIG_DIR: "" } }))

vi.mock("../../helpers", async () => {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  return { dirs: mockDirs, join: path.join, mkdir: fs.mkdir, readFile: fs.readFile }
})

import {
  __resetSessionArchiveForTest,
  archiveReason,
  AUTO_ARCHIVE_AFTER_MS,
  forgetSessions,
  isStillArchived,
  REACTIVATION_GRACE_MS,
  readArchive,
  setSessionsArchived,
} from "../../lib/sessionArchive"

describe("sessionArchive", () => {
  let dir: string
  const filePath = () => join(mockDirs.SESSION_CONFIG_DIR, "archived-sessions.json")

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cogpit-archive-"))
    mockDirs.SESSION_CONFIG_DIR = join(dir, "session-config")
    __resetSessionArchiveForTest()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("starts empty when nothing has been archived", async () => {
    const snapshot = await readArchive()
    expect(snapshot.archived.size).toBe(0)
    expect(snapshot.kept.size).toBe(0)
  })

  it("archives, persists, and restores sessions, keeping restored ones", async () => {
    expect(await setSessionsArchived(["a", "b"], true, 1_000)).toEqual(["a", "b"])
    expect(await setSessionsArchived(["a"], true, 2_000)).toEqual([])

    expect(JSON.parse(await readFile(filePath(), "utf-8"))).toEqual({
      version: 2, sessions: { a: 1_000, b: 1_000 }, kept: [],
    })

    expect(await setSessionsArchived(["a", "missing"], false)).toEqual(["a", "missing"])
    expect(await setSessionsArchived(["a"], false)).toEqual([])
    const snapshot = await readArchive()
    expect([...snapshot.archived.keys()]).toEqual(["b"])
    expect([...snapshot.kept]).toEqual(["a", "missing"])

    // Archiving a kept session drops the exemption again.
    expect(await setSessionsArchived(["a"], true, 3_000)).toEqual(["a"])
    expect((await readArchive()).kept.has("a")).toBe(false)
  })

  it("returns a snapshot that later writes do not mutate", async () => {
    await setSessionsArchived(["a"], true, 5)
    const snapshot = await readArchive()
    await setSessionsArchived(["a"], false)
    expect(snapshot.archived.has("a")).toBe(true)
  })

  it("forgets deleted sessions entirely", async () => {
    await setSessionsArchived(["a"], true, 5)
    await setSessionsArchived(["b"], false)
    await forgetSessions(["a", "b"])
    const snapshot = await readArchive()
    expect(snapshot.archived.size).toBe(0)
    expect(snapshot.kept.size).toBe(0)
  })

  it("reloads the file after a reset, ignoring corrupt content", async () => {
    await setSessionsArchived(["a"], true, 5)
    await setSessionsArchived(["k"], false)
    __resetSessionArchiveForTest()
    const snapshot = await readArchive()
    expect(snapshot.archived.get("a")).toBe(5)
    expect(snapshot.kept.has("k")).toBe(true)

    await writeFile(filePath(), "{not json")
    __resetSessionArchiveForTest()
    expect((await readArchive()).archived.size).toBe(0)
  })

  it("surfaces a failed write to the caller", async () => {
    await writeFile(join(dir, "blocker"), "")
    mockDirs.SESSION_CONFIG_DIR = join(dir, "blocker")
    __resetSessionArchiveForTest()
    await expect(setSessionsArchived(["a"], true)).rejects.toThrow()
  })

  it("treats activity after the grace period as a resumed session", () => {
    const archivedAt = 100_000
    expect(isStillArchived(undefined, archivedAt)).toBe(false)
    expect(isStillArchived(archivedAt, archivedAt - 1)).toBe(true)
    expect(isStillArchived(archivedAt, archivedAt + REACTIVATION_GRACE_MS)).toBe(true)
    expect(isStillArchived(archivedAt, archivedAt + REACTIVATION_GRACE_MS + 1)).toBe(false)
  })

  it("explains why a session is archived", () => {
    const now = 10 * AUTO_ARCHIVE_AFTER_MS
    const snapshot = { archived: new Map([["manual", now - 1_000]]), kept: new Set(["kept"]) }
    expect(archiveReason(snapshot, "manual", now - 2_000, now)).toBe("manual")
    expect(archiveReason(snapshot, "manual", now + REACTIVATION_GRACE_MS * 2, now)).toBe(null)
    expect(archiveReason(snapshot, "fresh", now - 1_000, now)).toBe(null)
    expect(archiveReason(snapshot, "idle", now - AUTO_ARCHIVE_AFTER_MS - 1, now)).toBe("inactive")
    expect(archiveReason(snapshot, "kept", now - AUTO_ARCHIVE_AFTER_MS - 1, now)).toBe(null)
  })
})

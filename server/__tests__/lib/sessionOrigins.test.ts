// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockDirs, writes } = vi.hoisted(() => ({
  mockDirs: { SESSION_CONFIG_DIR: "" },
  writes: { failNext: false },
}))

vi.mock("../../helpers", async () => {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  return { dirs: mockDirs, join: path.join, mkdir: fs.mkdir, readFile: fs.readFile }
})

vi.mock("../../atomicJsonFile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../atomicJsonFile")>()
  return {
    ...actual,
    writeOwnerOnlyJson: async (...args: Parameters<typeof actual.writeOwnerOnlyJson>) => {
      if (writes.failNext) {
        writes.failNext = false
        throw new Error("disk full")
      }
      return actual.writeOwnerOnlyJson(...args)
    },
  }
})

import {
  __resetSessionOriginsForTest,
  forgetSessionOrigins,
  recordSessionOrigin,
  sessionChildren,
  sessionOrigin,
  sessionParents,
} from "../../lib/sessionOrigins"

describe("sessionOrigins", () => {
  let dir: string
  const filePath = () => join(mockDirs.SESSION_CONFIG_DIR, "session-origins.json")

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cogpit-origins-"))
    mockDirs.SESSION_CONFIG_DIR = join(dir, "session-config")
    __resetSessionOriginsForTest()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("lists a parent's children oldest first", async () => {
    await recordSessionOrigin("child-b", { parentSessionId: "parent" }, 200)
    await recordSessionOrigin("child-a", { parentSessionId: "parent", deviceId: "dev_1" }, 100)
    await recordSessionOrigin("other", { parentSessionId: "someone-else" }, 50)

    expect(await sessionChildren("parent")).toEqual(["child-a", "child-b"])
    expect(await sessionOrigin("child-a")).toEqual({ parentSessionId: "parent", deviceId: "dev_1", createdAt: 100 })
    expect(await sessionOrigin("unknown")).toBeNull()
  })

  it("records a device without a parent and merges later facts", async () => {
    await recordSessionOrigin("remote", { deviceId: "dev_1" }, 100)
    await recordSessionOrigin("remote", { parentSessionId: "parent" }, 300)
    expect(await sessionOrigin("remote")).toEqual({ parentSessionId: "parent", deviceId: "dev_1", createdAt: 100 })
  })

  it("persists only environment metadata across reloads", async () => {
    const handoff = { repoRoot: "/repo", base: "a".repeat(40), workspaceId: "repo-0123456789/task", branch: "cogpit/box/task", remoteCwd: "/remote/task", environment: { source: "caller" as const, files: [".env.local"] }, run: { port: 40001, composeProjectName: "cogpit-0123456789abcdef" } }
    await recordSessionOrigin("remote-env", { deviceId: "dev_1", handoff })
    __resetSessionOriginsForTest()
    expect((await sessionOrigin("remote-env"))?.handoff).toEqual(handoff)
    expect(await readFile(filePath(), "utf8")).toContain('".env.local"')
  })

  it("keeps whether the user answers a session's questions", async () => {
    await recordSessionOrigin("asks", { asksUser: true }, 100)
    __resetSessionOriginsForTest()
    expect(await sessionOrigin("asks")).toEqual({ asksUser: true, createdAt: 100 })
  })

  it("keeps the name a session was started with, and the first one wins", async () => {
    await recordSessionOrigin("lane", { parentSessionId: "coordinator", name: "w3-rooftop" }, 100)
    await recordSessionOrigin("lane", { parentSessionId: "coordinator", name: "renamed later" }, 200)
    __resetSessionOriginsForTest()
    expect(await sessionOrigin("lane")).toEqual({ parentSessionId: "coordinator", name: "w3-rooftop", createdAt: 100 })
  })

  it("does not record a session that only has a name", async () => {
    await recordSessionOrigin("plain", { name: "just a name" })
    expect(await sessionOrigin("plain")).toBeNull()
  })

  it("lists every session another session started, with when and as what", async () => {
    await recordSessionOrigin("lane", { parentSessionId: "coordinator", name: "w3-rooftop" }, 100)
    await recordSessionOrigin("reviewer", { parentSessionId: "lane" }, 200)
    await recordSessionOrigin("remote-only", { deviceId: "dev_1" }, 300)

    expect(await sessionParents()).toEqual(new Map([
      ["lane", { parentSessionId: "coordinator", createdAt: 100, name: "w3-rooftop" }],
      ["reviewer", { parentSessionId: "lane", createdAt: 200 }],
    ]))
  })

  it("ignores a session naming itself as its parent", async () => {
    await recordSessionOrigin("same", { parentSessionId: "same" })
    expect(await sessionOrigin("same")).toBeNull()
  })

  it("persists across a reload and drops forgotten sessions", async () => {
    await recordSessionOrigin("child", { parentSessionId: "parent" }, 100)
    __resetSessionOriginsForTest()
    expect(await sessionChildren("parent")).toEqual(["child"])

    await forgetSessionOrigins(["child"])
    __resetSessionOriginsForTest()
    expect(await sessionChildren("parent")).toEqual([])
    expect(JSON.parse(await readFile(filePath(), "utf-8"))).toEqual({ version: 1, sessions: {} })
  })

  it("takes over the lineage file an earlier version wrote, under what it already knows", async () => {
    const legacyPath = join(mockDirs.SESSION_CONFIG_DIR, "session-lineage.json")
    await mkdir(mockDirs.SESSION_CONFIG_DIR, { recursive: true })
    await writeFile(legacyPath, JSON.stringify({
      version: 1,
      sessions: {
        old: { parentSessionId: "p", createdAt: 1 },
        both: { parentSessionId: "p", createdAt: 2 },
      },
    }))
    await writeFile(filePath(), JSON.stringify({
      version: 1,
      sessions: { both: { parentSessionId: "p", deviceId: "dev_1", createdAt: 3 } },
    }))

    expect(await sessionChildren("p")).toEqual(["old", "both"])
    expect(await sessionOrigin("both")).toEqual({ parentSessionId: "p", deviceId: "dev_1", createdAt: 3 })

    // Folded in once: the merged record is on disk and the old file is gone,
    // so a session forgotten later does not come back from it.
    await expect(readFile(legacyPath, "utf-8")).rejects.toThrow()
    await forgetSessionOrigins(["old"])
    __resetSessionOriginsForTest()
    expect(await sessionChildren("p")).toEqual(["both"])
  })

  it("finishes taking over the lineage file on a later write when the first one fails", async () => {
    const legacyPath = join(mockDirs.SESSION_CONFIG_DIR, "session-lineage.json")
    await mkdir(mockDirs.SESSION_CONFIG_DIR, { recursive: true })
    await writeFile(legacyPath, JSON.stringify({
      version: 1,
      sessions: { old: { parentSessionId: "p", createdAt: 1 }, kept: { parentSessionId: "p", createdAt: 2 } },
    }))

    writes.failNext = true
    expect(await sessionChildren("p")).toEqual(["old", "kept"])
    // The entries exist nowhere else yet, so the old file has to survive the failed write.
    expect(JSON.parse(await readFile(legacyPath, "utf-8")).sessions.old).toBeDefined()

    await forgetSessionOrigins(["old"])
    await expect(readFile(legacyPath, "utf-8")).rejects.toThrow()
    __resetSessionOriginsForTest()
    expect(await sessionChildren("p")).toEqual(["kept"])
  })

  it("starts empty from a corrupt file and skips malformed entries", async () => {
    await mkdir(mockDirs.SESSION_CONFIG_DIR, { recursive: true })
    await writeFile(filePath(), JSON.stringify({
      version: 1,
      sessions: {
        good: { parentSessionId: "p", createdAt: 1 },
        bad: { parentSessionId: 5, createdAt: 1 },
        empty: { createdAt: 1 },
      },
    }))
    expect(await sessionChildren("p")).toEqual(["good"])
    expect(await sessionOrigin("empty")).toBeNull()

    await writeFile(filePath(), "{not json")
    __resetSessionOriginsForTest()
    expect(await sessionChildren("p")).toEqual([])
  })
})

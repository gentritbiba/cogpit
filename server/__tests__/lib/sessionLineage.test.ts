// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
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
  __resetSessionLineageForTest,
  forgetSessionLineage,
  recordSessionParent,
  sessionChildren,
  sessionParent,
} from "../../lib/sessionLineage"

describe("sessionLineage", () => {
  let dir: string
  const filePath = () => join(mockDirs.SESSION_CONFIG_DIR, "session-lineage.json")

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cogpit-lineage-"))
    mockDirs.SESSION_CONFIG_DIR = join(dir, "session-config")
    __resetSessionLineageForTest()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("lists a parent's children oldest first", async () => {
    await recordSessionParent("child-b", "parent", 200)
    await recordSessionParent("child-a", "parent", 100)
    await recordSessionParent("other", "someone-else", 50)

    expect(await sessionChildren("parent")).toEqual(["child-a", "child-b"])
    expect(await sessionParent("child-b")).toBe("parent")
    expect(await sessionParent("unknown")).toBeNull()
  })

  it("ignores a session naming itself as its parent", async () => {
    await recordSessionParent("same", "same")
    expect(await sessionParent("same")).toBeNull()
  })

  it("persists across a reload and drops forgotten sessions", async () => {
    await recordSessionParent("child", "parent", 100)
    __resetSessionLineageForTest()
    expect(await sessionChildren("parent")).toEqual(["child"])

    await forgetSessionLineage(["child"])
    __resetSessionLineageForTest()
    expect(await sessionChildren("parent")).toEqual([])
    expect(JSON.parse(await readFile(filePath(), "utf-8"))).toEqual({ version: 1, sessions: {} })
  })

  it("starts empty from a corrupt file and skips malformed entries", async () => {
    await mkdir(mockDirs.SESSION_CONFIG_DIR, { recursive: true })
    await writeFile(filePath(), JSON.stringify({
      version: 1,
      sessions: { good: { parentSessionId: "p", createdAt: 1 }, bad: { parentSessionId: 5 } },
    }))
    expect(await sessionChildren("p")).toEqual(["good"])

    await writeFile(filePath(), "{not json")
    __resetSessionLineageForTest()
    expect(await sessionChildren("p")).toEqual([])
  })
})

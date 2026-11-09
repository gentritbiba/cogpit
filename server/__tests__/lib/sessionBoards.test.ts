// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockDirs } = vi.hoisted(() => ({ mockDirs: { SESSION_CONFIG_DIR: "" } }))

vi.mock("../../helpers", async () => {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  return { dirs: mockDirs, join: path.join, mkdir: fs.mkdir, readFile: fs.readFile }
})

import { parseBoardContent, parseBoardProgress, saysWhatIsLeft } from "../../../shared/contracts/board"
import {
  __resetSessionBoardsForTest,
  allSessionBoards,
  clearSessionBoard,
  sessionBoard,
  setSessionBoard,
  setSessionBoardProgress,
} from "../../lib/sessionBoards"

describe("saysWhatIsLeft", () => {
  it("needs a Next-like section with items, or complete progress", () => {
    const section = (title: string, items: string[]) => ({ sections: [{ title, items }] })
    expect(saysWhatIsLeft(section("Next", ["renderer"]))).toBe(true)
    expect(saysWhatIsLeft(section("Still to do", ["docs"]))).toBe(true)
    expect(saysWhatIsLeft(section("Next", []))).toBe(false)
    expect(saysWhatIsLeft(section("Now", ["parser"]))).toBe(false)
    expect(saysWhatIsLeft({ progress: { done: 9, total: 9 }, sections: [] })).toBe(true)
    expect(saysWhatIsLeft({ progress: { done: 8, total: 9 }, sections: [] })).toBe(false)
  })
})

describe("parseBoardContent", () => {
  it("keeps a title, progress and sections with their tone", () => {
    expect(parseBoardContent({
      title: "Wave 3",
      progress: "35/99",
      sections: [
        { title: "Now", items: ["storefront PR shipping", 42] },
        { title: "Needs you", tone: "warning", items: ["sentry-cli login"] },
        { title: "Odd", tone: "purple", items: [] },
        { items: ["no title"] },
      ],
    })).toEqual({
      title: "Wave 3",
      progress: { done: 35, total: 99 },
      sections: [
        { title: "Now", items: ["storefront PR shipping", "42"] },
        { title: "Needs you", tone: "warning", items: ["sentry-cli login"] },
        { title: "Odd", items: [] },
      ],
    })
  })

  it("is null for a document that says nothing a board can show", () => {
    expect(parseBoardContent({ sections: [] })).toBeNull()
    expect(parseBoardContent("just text")).toBeNull()
    expect(parseBoardProgress("35 of 99")).toBeNull()
    expect(parseBoardProgress({ done: 120, total: 99 })).toEqual({ done: 99, total: 99 })
  })
})

describe("sessionBoards", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cogpit-boards-"))
    mockDirs.SESSION_CONFIG_DIR = join(dir, "session-config")
    __resetSessionBoardsForTest()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("keeps a board across a reload", async () => {
    await setSessionBoard("lead", { title: "Wave 3", sections: [{ title: "Now", items: ["a"] }] }, 100)
    __resetSessionBoardsForTest()
    expect(await sessionBoard("lead")).toEqual({ sessionId: "lead", title: "Wave 3", sections: [{ title: "Now", items: ["a"] }], updatedAt: 100 })
    expect(JSON.parse(await readFile(join(mockDirs.SESSION_CONFIG_DIR, "session-boards.json"), "utf-8")).version).toBe(1)
  })

  it("lists every board, the most recently updated first", async () => {
    await setSessionBoard("lead", { title: "Wave 3", sections: [] }, 100)
    await setSessionBoard("worker", { title: "Nav fix", sections: [] }, 300)
    await setSessionBoard("reviewer", { title: "Review", sections: [] }, 200)
    expect((await allSessionBoards()).map((board) => board.sessionId)).toEqual(["worker", "reviewer", "lead"])
  })

  it("moves only the progress, and starts a board for it", async () => {
    await setSessionBoard("lead", { title: "Wave 3", sections: [] }, 100)
    expect(await setSessionBoardProgress("lead", { done: 36, total: 99 }, 200)).toEqual({
      sessionId: "lead", title: "Wave 3", sections: [], progress: { done: 36, total: 99 }, updatedAt: 200,
    })
    expect(await setSessionBoardProgress("other", { done: 1, total: 2 }, 300)).toMatchObject({ sections: [], progress: { done: 1, total: 2 } })
  })

  it("clears a board", async () => {
    await setSessionBoard("lead", { title: "x", sections: [] })
    expect(await clearSessionBoard("lead")).toBe(true)
    expect(await clearSessionBoard("lead")).toBe(false)
    expect(await sessionBoard("lead")).toBeNull()
  })
})

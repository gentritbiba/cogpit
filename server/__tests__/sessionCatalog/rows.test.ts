// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ getSessionMeta: vi.fn(), getSessionStatus: vi.fn() }))
vi.mock("../../sessionMetadata", async (original) => ({
  ...await original<typeof import("../../sessionMetadata")>(),
  getSessionMeta: mocks.getSessionMeta,
  getSessionStatus: mocks.getSessionStatus,
}))

import { markCatalogChanged, reportTouchedFiles, subscribeCatalog, type CatalogChange } from "../../sessionCatalog/changes"
import { resetFacts } from "../../sessionCatalog/facts"
import { catalogRow, peekCatalogRow, startRowRechecks, stopRowRechecks } from "../../sessionCatalog/rows"

let changes: CatalogChange[]
let unsubscribe: () => void

beforeEach(() => {
  resetFacts()
  changes = []
  unsubscribe = subscribeCatalog((change) => changes.push(change))
  mocks.getSessionMeta.mockReset().mockResolvedValue({ aiTitle: "first", turnCount: 1, firstUserMessage: "", lastUserMessage: "" })
  mocks.getSessionStatus.mockReset().mockResolvedValue({ status: "tool_use" })
  startRowRechecks()
})

afterEach(() => {
  unsubscribe()
  stopRowRechecks()
  resetFacts()
})

describe("catalog rows", () => {
  it("reads a row once per size and mtime", async () => {
    const file = { filePath: "/rows/a.jsonl", mtimeMs: 1, size: 10 }
    expect(peekCatalogRow(file)).toBeNull()
    await catalogRow(file)
    await catalogRow(file)
    expect(mocks.getSessionMeta).toHaveBeenCalledOnce()
    expect(peekCatalogRow(file)?.status.status).toBe("tool_use")
    expect(peekCatalogRow({ ...file, size: 11 })).toBeNull()
  })

  it("turns a write that changed the row into a visible change, and one that did not into nothing more", async () => {
    await catalogRow({ filePath: "/rows/b.jsonl", mtimeMs: 1, size: 10 })

    reportTouchedFiles([{ filePath: "/rows/b.jsonl", mtimeMs: 2, size: 20 }])
    markCatalogChanged("touch")
    await vi.waitFor(() => expect(mocks.getSessionMeta).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(changes.map((change) => change.kind)).toEqual(["touch"])

    mocks.getSessionStatus.mockResolvedValue({ status: "idle" })
    reportTouchedFiles([{ filePath: "/rows/b.jsonl", mtimeMs: 3, size: 30 }])
    await vi.waitFor(() => expect(changes.map((change) => change.kind)).toEqual(["touch", "visible"]), { timeout: 3_000 })
  })

  it("counts a write to a session no list has read as visible without reading it", async () => {
    reportTouchedFiles([{ filePath: "/rows/c.jsonl", mtimeMs: 1, size: 1 }])
    await vi.waitFor(() => expect(changes.map((change) => change.kind)).toEqual(["visible"]))
    expect(mocks.getSessionMeta).not.toHaveBeenCalled()
  })

  it("does no rechecks while nobody listens", async () => {
    unsubscribe()
    await catalogRow({ filePath: "/rows/d.jsonl", mtimeMs: 1, size: 10 })
    reportTouchedFiles([{ filePath: "/rows/d.jsonl", mtimeMs: 2, size: 20 }])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mocks.getSessionMeta).toHaveBeenCalledOnce()
  })
})

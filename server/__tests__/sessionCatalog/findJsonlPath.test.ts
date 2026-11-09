// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const mocks = vi.hoisted(() => ({ sessionFileFor: vi.fn(), findSessionFile: vi.fn() }))
vi.mock("../../sessionCatalog", () => ({ sessionFileFor: mocks.sessionFileFor }))
vi.mock("../../agents", async (original) => ({
  ...await original<typeof import("../../agents")>(),
  storeFor: () => ({ findSessionFile: mocks.findSessionFile }),
}))

import { findJsonlPath } from "../../sessionPaths"

const ID = "11111111-1111-4111-8111-111111111111"
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "find-jsonl-"))
  mocks.sessionFileFor.mockReset().mockReturnValue(null)
  mocks.findSessionFile.mockReset().mockResolvedValue(null)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("findJsonlPath", () => {
  it("answers from the catalog without asking any store", async () => {
    const file = join(dir, `${ID}.jsonl`)
    writeFileSync(file, "{}\n")
    mocks.sessionFileFor.mockReturnValue(file)
    expect(await findJsonlPath(ID)).toBe(file)
    expect(mocks.findSessionFile).not.toHaveBeenCalled()
  })

  it("falls back to the stores when the catalog's file has gone", async () => {
    mocks.sessionFileFor.mockReturnValue(join(dir, "gone.jsonl"))
    mocks.findSessionFile.mockResolvedValue("/found/by/store.jsonl")
    expect(await findJsonlPath(ID)).toBe("/found/by/store.jsonl")
  })

  it("falls back to the stores when the catalog does not know the id", async () => {
    mocks.findSessionFile.mockResolvedValue("/found/by/store.jsonl")
    expect(await findJsonlPath(ID)).toBe("/found/by/store.jsonl")
    expect(mocks.sessionFileFor).toHaveBeenCalledWith(ID)
  })
})

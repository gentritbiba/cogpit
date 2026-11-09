// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ search: vi.fn(async (_filePath: string, _query: string): Promise<string | null> => null) }))
vi.mock("../../helpers", () => ({ searchSessionMessages: mocks.search }))

import { __resetSearchMemoForTest, searchTranscript } from "../../sessionList/searchMemo"

describe("searchTranscript", () => {
  afterEach(() => {
    __resetSearchMemoForTest()
    mocks.search.mockReset().mockResolvedValue(null)
  })

  const file = { filePath: "/t/a.jsonl", mtimeMs: 1, size: 10 }

  it("reads a transcript again only once it changed", async () => {
    mocks.search.mockResolvedValue("found it")
    await expect(searchTranscript(file, "it")).resolves.toBe("found it")
    await expect(searchTranscript(file, "it")).resolves.toBe("found it")
    expect(mocks.search).toHaveBeenCalledTimes(1)

    await searchTranscript({ ...file, size: 11 }, "it")
    await searchTranscript({ ...file, mtimeMs: 2, size: 11 }, "it")
    expect(mocks.search).toHaveBeenCalledTimes(3)
  })

  it("knows a longer query misses where a shorter one inside it found nothing", async () => {
    await expect(searchTranscript(file, "Per")).resolves.toBeNull()
    await expect(searchTranscript(file, "perf")).resolves.toBeNull()
    expect(mocks.search).toHaveBeenCalledTimes(1)

    await searchTranscript({ ...file, size: 12 }, "perf")
    expect(mocks.search).toHaveBeenCalledTimes(2)
  })

  it("reads again for a longer query where the shorter one found something", async () => {
    mocks.search.mockResolvedValueOnce("perf").mockResolvedValueOnce(null)
    await searchTranscript(file, "per")
    await expect(searchTranscript(file, "perfx")).resolves.toBeNull()
    expect(mocks.search).toHaveBeenCalledTimes(2)
  })
})

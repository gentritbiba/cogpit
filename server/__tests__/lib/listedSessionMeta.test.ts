// @vitest-environment node
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getSessionMeta: vi.fn(async () => ({ firstUserMessage: "Hi", lastTimestamp: "2026-11-07T10:00:00.000Z" })),
  getSessionStatus: vi.fn(async () => ({ status: "completed" })),
}))
vi.mock("../../helpers", () => mocks)

import { lastActivityOf, listedMeta } from "../../lib/listedSessionMeta"

describe("listedMeta", () => {
  it("reads a listed transcript once per revision, for every reader", async () => {
    const session = { filePath: "/work/listed-once.jsonl", mtimeMs: 1_000 }
    const [first, second] = await Promise.all([listedMeta(session), listedMeta({ ...session })])
    expect(first).toBe(second)
    expect(first).toMatchObject({ meta: { firstUserMessage: "Hi" }, status: { status: "completed" } })
    expect(mocks.getSessionMeta).toHaveBeenCalledTimes(1)
    await listedMeta({ ...session, mtimeMs: 2_000 })
    expect(mocks.getSessionMeta).toHaveBeenCalledTimes(2)
    expect(mocks.getSessionStatus).toHaveBeenCalledTimes(2)
  })
})

describe("lastActivityOf", () => {
  it("takes the newest record's time, else the transcript's mtime", () => {
    expect(lastActivityOf({ lastTimestamp: "2026-11-07T10:00:00.000Z" }, 0)).toBe("2026-11-07T10:00:00.000Z")
    expect(lastActivityOf({}, Date.parse("2026-11-01T00:00:00.000Z"))).toBe("2026-11-01T00:00:00.000Z")
  })
})

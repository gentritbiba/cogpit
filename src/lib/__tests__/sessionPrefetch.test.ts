import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ParsedSession } from "@/lib/types"

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))
vi.mock("@/lib/sessionCache", () => ({
  sessionCache: { get: vi.fn(() => undefined), set: vi.fn() },
}))
vi.mock("@/lib/device", () => ({ getActiveDeviceId: vi.fn(() => "local") }))

import { prefetchSession } from "@/lib/sessionPrefetch"
import { authFetch } from "@/lib/auth"
import { sessionCache } from "@/lib/sessionCache"
import { getActiveDeviceId } from "@/lib/device"

const mockAuthFetch = vi.mocked(authFetch)
const mockGet = vi.mocked(sessionCache.get)
const mockSet = vi.mocked(sessionCache.set)
const mockDeviceId = vi.mocked(getActiveDeviceId)

function tailResponse() {
  return new Response(
    JSON.stringify({
      headerLines: ["{}"],
      tailLines: ["{}"],
      byteOffset: 100,
      totalSize: 200,
      hasMore: false,
    }),
    { status: 200 },
  )
}

const parsed = { turns: [] } as unknown as ParsedSession

beforeEach(() => {
  vi.clearAllMocks()
  mockGet.mockReturnValue(undefined)
  mockDeviceId.mockReturnValue("local")
})

describe("prefetchSession device scoping", () => {
  it("caches the parsed session when the active device is unchanged", async () => {
    mockAuthFetch.mockResolvedValue(tailResponse())
    const workerParse = vi.fn(async () => parsed)

    await prefetchSession("-dir", "sess.jsonl", workerParse)

    expect(workerParse).toHaveBeenCalledOnce()
    expect(mockSet).toHaveBeenCalledOnce()
  })

  it("does not write the cache when the device changes mid-flight", async () => {
    mockAuthFetch.mockResolvedValue(tailResponse())
    const workerParse = vi.fn(async () => parsed)

    // getActiveDeviceId is called: (1) makeKey, (2) pre-fetch snapshot,
    // (3) post-parse guard. Simulate a switch between the snapshot and the guard.
    mockDeviceId
      .mockReturnValueOnce("device-a") // makeKey
      .mockReturnValueOnce("device-a") // snapshot before authFetch
      .mockReturnValueOnce("device-b") // guard after parse (switched!)

    await prefetchSession("-dir", "sess.jsonl", workerParse)

    // It still fetched and parsed…
    expect(mockAuthFetch).toHaveBeenCalledOnce()
    expect(workerParse).toHaveBeenCalledOnce()
    // …but must NOT poison device-a's cache with the completion.
    expect(mockSet).not.toHaveBeenCalled()
  })
})

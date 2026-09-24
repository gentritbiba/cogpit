// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const MINUTE = 60_000
const RATE_DOCUMENT = { "priced-model": { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 } }

let dataRoot: string
let service: typeof import("../../lib/usageCost/service")
let fetchMock: MockInstance<typeof fetch>

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ["Date"] })
  dataRoot = await mkdtemp(join(tmpdir(), "cogpit-usage-rates-"))
  ;(await import("../../config")).setDataRoot(dataRoot)
  service = await import("../../lib/usageCost/service")
  fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await rm(dataRoot, { recursive: true, force: true })
})

describe("getModelRates", () => {
  it("leaves a rate table it could not fetch alone for a while, instead of stalling every read on it", async () => {
    expect((await service.getModelRates()).status).toBe("unavailable")
    expect((await service.getModelRates()).status).toBe("unavailable")
    expect(fetchMock).toHaveBeenCalledOnce()

    vi.setSystemTime(Date.now() + 10 * MINUTE)
    fetchMock.mockResolvedValue(new Response(JSON.stringify(RATE_DOCUMENT)))

    const loaded = await service.getModelRates()
    expect(loaded.status).toBe("fresh")
    expect(loaded.rates.size).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

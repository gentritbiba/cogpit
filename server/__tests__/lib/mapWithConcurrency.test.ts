// @vitest-environment node
import { describe, expect, it, vi } from "vitest"

import { mapWithConcurrency } from "../../lib/mapWithConcurrency"

describe("mapWithConcurrency", () => {
  it("caps concurrent work without changing output ordering", async () => {
    let active = 0
    let maxActive = 0
    let started = 0
    let releaseFirstWave: (() => void) | undefined
    const firstWave = new Promise<void>((resolve) => {
      releaseFirstWave = resolve
    })

    const pending = mapWithConcurrency([0, 1, 2, 3, 4, 5], 3, async (value) => {
      active += 1
      started += 1
      maxActive = Math.max(maxActive, active)
      if (started <= 3) await firstWave
      active -= 1
      return value * 2
    })

    await vi.waitFor(() => expect(started).toBe(3))
    expect(maxActive).toBe(3)
    releaseFirstWave?.()

    await expect(pending).resolves.toEqual([0, 2, 4, 6, 8, 10])
    expect(maxActive).toBe(3)
  })
})

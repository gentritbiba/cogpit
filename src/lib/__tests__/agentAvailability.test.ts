import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { makeProviderUpdateInfo } from "@/__tests__/fixtures"

const mocks = vi.hoisted(() => ({ fetchProviderUpdates: vi.fn() }))
vi.mock("@/lib/providerUpdates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/providerUpdates")>()),
  fetchProviderUpdates: mocks.fetchProviderUpdates,
}))

import { _resetAgentAvailabilityForTests, refreshAgentAvailability, useAgentAvailability } from "@/lib/agents/availability"

const onMachine = (binaryPath: string) => [makeProviderUpdateInfo({ binaryPath })]
const goTo = (path: string) => window.history.pushState(null, "", path)

beforeEach(() => {
  _resetAgentAvailabilityForTests()
  goTo("/")
})
afterEach(() => {
  goTo("/")
  vi.clearAllMocks()
})

describe("useAgentAvailability", () => {
  it("asks each machine for itself when the active device changes, in both directions", async () => {
    mocks.fetchProviderUpdates.mockResolvedValueOnce(onMachine("/local/claude")).mockResolvedValueOnce(onMachine("/box/claude"))
    const { result, rerender } = renderHook(() => useAgentAvailability())
    await waitFor(() => expect(result.current?.[0].binaryPath).toBe("/local/claude"))

    act(() => goTo("/d/box"))
    rerender()
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current?.[0].binaryPath).toBe("/box/claude"))

    act(() => goTo("/"))
    rerender()
    expect(result.current?.[0].binaryPath).toBe("/local/claude")
    expect(mocks.fetchProviderUpdates).toHaveBeenCalledTimes(2)
  })

  it("drops an answer that arrives after the device changed", async () => {
    let answerLocal!: (value: unknown) => void
    mocks.fetchProviderUpdates
      .mockReturnValueOnce(new Promise((resolve) => { answerLocal = resolve }))
      .mockResolvedValueOnce(onMachine("/box/claude"))
    const local = refreshAgentAvailability()

    goTo("/d/box")
    const { result } = renderHook(() => useAgentAvailability())
    await waitFor(() => expect(result.current?.[0].binaryPath).toBe("/box/claude"))

    answerLocal(onMachine("/local/claude"))
    await local
    expect(result.current?.[0].binaryPath).toBe("/box/claude")
    // The late local answer was not kept: going back asks the local machine again.
    mocks.fetchProviderUpdates.mockResolvedValueOnce(onMachine("/local/fresh"))
    goTo("/")
    const { result: back } = renderHook(() => useAgentAvailability())
    expect(back.current).toBeNull()
    await waitFor(() => expect(back.current?.[0].binaryPath).toBe("/local/fresh"))
  })
})

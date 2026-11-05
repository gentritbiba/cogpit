import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { makeProviderUpdateInfo } from "@/__tests__/fixtures"

const mocks = vi.hoisted(() => ({ fetchProviderUpdates: vi.fn(), runProviderUpdate: vi.fn() }))
vi.mock("@/lib/providerUpdates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/providerUpdates")>()),
  fetchProviderUpdates: mocks.fetchProviderUpdates,
  runProviderUpdate: mocks.runProviderUpdate,
}))

import { _resetAgentAvailabilityForTests, refreshAgentAvailability, useAgentAvailability } from "@/lib/agents/availability"
import { useProviderUpdates } from "@/hooks/useProviderUpdates"

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

  it("files an update's result under the machine that ran it, not the one active when it lands", async () => {
    mocks.fetchProviderUpdates.mockResolvedValueOnce(onMachine("/local/claude")).mockResolvedValueOnce(onMachine("/box/claude"))
    let finishUpdate!: (value: unknown) => void
    mocks.runProviderUpdate.mockReturnValueOnce(new Promise((resolve) => { finishUpdate = resolve }))
    const updates = renderHook(() => useProviderUpdates())
    const local = renderHook(() => useAgentAvailability())
    await waitFor(() => expect(local.result.current?.[0].binaryPath).toBe("/local/claude"))

    let running!: Promise<void>
    act(() => { running = updates.result.current.update("claude") })
    goTo("/d/box")
    const box = renderHook(() => useAgentAvailability())
    await waitFor(() => expect(box.result.current?.[0].binaryPath).toBe("/box/claude"))

    const updated = makeProviderUpdateInfo({ binaryPath: "/local/claude-updated", signInCommand: "/local/claude-updated auth login" })
    await act(async () => {
      finishUpdate({ provider: "claude", status: "succeeded", message: "Claude Code updated", output: null, info: updated })
      await running
    })
    box.rerender()
    expect(box.result.current?.[0]).toMatchObject({ binaryPath: "/box/claude", signInCommand: "/usr/local/bin/claude auth login" })

    goTo("/")
    local.rerender()
    expect(local.result.current?.[0].binaryPath).toBe("/local/claude-updated")
  })
})

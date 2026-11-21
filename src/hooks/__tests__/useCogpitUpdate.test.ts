import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useCogpitUpdate } from "@/hooks/useCogpitUpdate"

function installApi(initial: ElectronUpdateState) {
  let push: (state: ElectronUpdateState) => void = () => {}
  const unsubscribe = vi.fn()
  const api = {
    getState: vi.fn().mockResolvedValue(initial),
    onState: vi.fn((cb: (state: ElectronUpdateState) => void) => {
      push = cb
      return unsubscribe
    }),
    install: vi.fn().mockResolvedValue(undefined),
  }
  window.electronUpdater = api
  return { api, unsubscribe, push: (state: ElectronUpdateState) => act(() => push(state)) }
}

afterEach(() => {
  delete window.electronUpdater
})

describe("useCogpitUpdate", () => {
  it("stays idle outside the desktop app", () => {
    const { result } = renderHook(() => useCogpitUpdate())
    expect(result.current).toMatchObject({ update: { status: "idle" }, restarting: false })
  })

  it("reads the main process's state, then follows what it pushes", async () => {
    const { push } = installApi({ status: "ready", version: "3.5.0", asksForPassword: false })
    const { result } = renderHook(() => useCogpitUpdate())

    await vi.waitFor(() => expect(result.current.update).toEqual({
      status: "ready", version: "3.5.0", asksForPassword: false,
    }))

    push({ status: "failed", version: "3.5.0", message: "nope", url: "https://example.test" })
    expect(result.current.update).toMatchObject({ status: "failed", message: "nope" })
  })

  it("installs, and clears the restarting flag once the state moves on", async () => {
    const { api, push } = installApi({ status: "ready", version: "3.5.0", asksForPassword: false })
    const { result } = renderHook(() => useCogpitUpdate())

    act(() => result.current.install())
    expect(api.install).toHaveBeenCalledOnce()
    expect(result.current.restarting).toBe(true)

    push({ status: "failed", version: "3.5.0", message: "pkexec was dismissed", url: "https://example.test" })
    expect(result.current.restarting).toBe(false)
  })

  it("unsubscribes and ignores a late first answer after unmount", async () => {
    let resolve: (state: ElectronUpdateState) => void = () => {}
    const { api, unsubscribe } = installApi({ status: "idle" })
    api.getState.mockReturnValue(new Promise((r) => { resolve = r }))
    const { result, unmount } = renderHook(() => useCogpitUpdate())

    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
    await act(async () => resolve({ status: "ready", version: "3.5.0", asksForPassword: false }))
    expect(result.current.update).toEqual({ status: "idle" })
  })
})

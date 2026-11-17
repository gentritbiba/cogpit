import { createElement, useLayoutEffect, useSyncExternalStore } from "react"
import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FlipGuard } from "../flipGuard"

/** A plan store whose every commit asks for the other plan: the shape of a layout that never settles. */
function flippingStore(guarded: boolean) {
  const guard = new FlipGuard()
  const listeners = new Set<() => void>()
  let plan = 0
  const flip = (): void => {
    if (guarded && !guard.allow(flip)) return
    plan = 1 - plan
    for (const listener of listeners) listener()
  }
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: () => plan,
    flip,
  }
}

function Flipping({ store }: { store: ReturnType<typeof flippingStore> }) {
  const plan = useSyncExternalStore(store.subscribe, store.get)
  useLayoutEffect(() => store.flip())
  return createElement("div", null, plan)
}

describe("FlipGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "requestAnimationFrame"] })
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("is what stands between a flipping plan and React error #185", () => {
    expect(() => render(createElement(Flipping, { store: flippingStore(false) }))).toThrow(/Maximum update depth/)
  })

  it("lets the first changes of a task through and moves the rest to the next frame", () => {
    const retry = vi.fn()
    const guard = new FlipGuard()
    const allowed = Array.from({ length: 20 }, () => guard.allow(retry)).filter(Boolean).length

    expect(allowed).toBe(12)
    expect(retry).not.toHaveBeenCalled()
    vi.advanceTimersToNextFrame()
    expect(retry).toHaveBeenCalledTimes(1)
    expect(guard.allow(retry)).toBe(true)
  })

  it("keeps a plan that never settles from crashing the tree", () => {
    const store = flippingStore(true)
    render(createElement(Flipping, { store }))
    act(() => { vi.advanceTimersToNextFrame() })
    act(() => { vi.advanceTimersToNextFrame() })
  })
})

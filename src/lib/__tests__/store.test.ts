import { describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { createStore, shallowEqual, useStoreSelector } from "@/lib/store"

type Action = { type: "add"; by: number } | { type: "rename"; name: string } | { type: "noop" }
interface State { count: number; name: string; items: number[] }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "add": return { ...state, count: state.count + action.by, items: [...state.items, action.by] }
    case "rename": return { ...state, name: action.name }
    default: return state
  }
}

const initial: State = { count: 0, name: "a", items: [] }

describe("createStore", () => {
  it("notifies subscribers only when the reducer returns a new state", () => {
    const store = createStore(reducer, initial)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.dispatch({ type: "noop" })
    expect(listener).not.toHaveBeenCalled()

    store.dispatch({ type: "add", by: 2 })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState().count).toBe(2)

    unsubscribe()
    store.dispatch({ type: "add", by: 1 })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("lets a listener unsubscribe another during a notification without skipping the rest", () => {
    const store = createStore(reducer, initial)
    const calls: string[] = []
    let unsubscribeB = () => {}
    store.subscribe(() => { calls.push("a"); unsubscribeB() })
    unsubscribeB = store.subscribe(() => calls.push("b"))
    store.subscribe(() => calls.push("c"))

    store.dispatch({ type: "add", by: 1 })
    expect(calls).toEqual(["a", "b", "c"])
  })
})

describe("useStoreSelector", () => {
  it("re-renders only when the selected value changes", () => {
    const store = createStore(reducer, initial)
    let renders = 0
    const { result } = renderHook(() => { renders++; return useStoreSelector(store, (state) => state.name) })
    expect(result.current).toBe("a")

    act(() => store.dispatch({ type: "add", by: 1 }))
    expect(renders).toBe(1)

    act(() => store.dispatch({ type: "rename", name: "b" }))
    expect(renders).toBe(2)
    expect(result.current).toBe("b")
  })

  it("keeps the previous object when a fresh selection is equal to it", () => {
    const store = createStore(reducer, initial)
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useStoreSelector(store, (state) => ({ count: state.count }), shallowEqual)
    })
    const first = result.current

    act(() => store.dispatch({ type: "rename", name: "b" }))
    expect(renders).toBe(1)
    expect(result.current).toBe(first)

    act(() => store.dispatch({ type: "add", by: 3 }))
    expect(renders).toBe(2)
    expect(result.current).toEqual({ count: 3 })
  })

  it("follows a selector that changes between renders", () => {
    const store = createStore(reducer, { ...initial, items: [4, 5] })
    const { result, rerender } = renderHook(({ index }) => useStoreSelector(store, (state) => state.items[index]), {
      initialProps: { index: 0 },
    })
    expect(result.current).toBe(4)
    rerender({ index: 1 })
    expect(result.current).toBe(5)
  })
})

describe("shallowEqual", () => {
  it("compares values under the same keys", () => {
    const items: number[] = []
    expect(shallowEqual({ a: 1, items }, { a: 1, items })).toBe(true)
    expect(shallowEqual({ a: 1, items }, { a: 1, items: [] })).toBe(false)
    expect(shallowEqual<Record<string, number>>({ a: 1 }, { a: 1, b: 2 })).toBe(false)
  })
})

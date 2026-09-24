// @vitest-environment node
import { describe, expect, it, vi } from "vitest"

import { listenerSet } from "../../lib/listenerSet"

describe("listenerSet", () => {
  it("delivers an emit to exactly the listeners subscribed when it began", () => {
    const listeners = listenerSet<number>(() => {})
    const seen: string[] = []
    let unsubscribeSecond = () => {}
    listeners.add((value) => {
      seen.push(`first:${value}`)
      unsubscribeSecond()
      if (value === 1) listeners.add((later) => seen.push(`late:${later}`))
    })
    unsubscribeSecond = listeners.add((value) => seen.push(`second:${value}`))

    listeners.emit(1)
    listeners.emit(2)

    expect(seen).toEqual(["first:1", "second:1", "first:2", "late:2"])
  })

  it("hands a throwing listener's error to onError and still runs the rest", () => {
    const onError = vi.fn()
    const listeners = listenerSet<string>(onError)
    const failure = new Error("broken")
    const seen: string[] = []
    listeners.add(() => {
      throw failure
    })
    listeners.add((value) => seen.push(value))

    listeners.emit("x")

    expect(onError).toHaveBeenCalledWith(failure)
    expect(seen).toEqual(["x"])
  })

  it("forgets every listener on clear", () => {
    const listeners = listenerSet<string>(() => {})
    const seen: string[] = []
    listeners.add((value) => seen.push(value))

    listeners.clear()
    listeners.emit("x")

    expect(seen).toEqual([])
  })
})

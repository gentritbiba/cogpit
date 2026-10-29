import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useHighlightedTokens } from "../useHighlightedTokens"
const { highlight } = vi.hoisted(() => ({ highlight: vi.fn() }))
vi.mock("@/lib/shiki", () => ({ highlightCode: highlight }))
function deferred() {
  let resolve!: (value: any) => void
  return { promise: new Promise<any>(done => { resolve = done }), resolve: (value: any) => resolve(value) }
}
beforeEach(() => { highlight.mockReset() })
afterEach(() => { vi.useRealTimers() })
describe("shared highlighting hook", () => {
  it("fences old content/theme results immediately, aborts obsolete work and ignores late promises", async () => {
    const first = deferred(), second = deferred()
    highlight.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const hook = renderHook(({ code, dark }) => useHighlightedTokens(code, "tsx", dark), { initialProps: { code: "old", dark: true } })
    const oldSignal = highlight.mock.calls[0][3] as AbortSignal
    await act(async () => first.resolve([[{ content: "old token" }]]))
    expect(hook.result.current?.[0][0].content).toBe("old token")
    hook.rerender({ code: "new", dark: false })
    expect(oldSignal.aborted).toBe(true)
    expect(hook.result.current).toBeNull()
    await act(async () => second.resolve([[{ content: "new token" }]]))
    expect(hook.result.current?.[0][0].content).toBe("new token")
    hook.unmount()
    expect((highlight.mock.calls[1][3] as AbortSignal).aborted).toBe(true)
  })
  it("coalesces editor keystrokes before worker admission", async () => {
    vi.useFakeTimers()
    highlight.mockResolvedValue(null)
    const hook = renderHook(({ code }) => useHighlightedTokens(code, "typescript", true, 80), { initialProps: { code: "a" } })
    hook.rerender({ code: "ab" })
    hook.rerender({ code: "abc" })
    expect(highlight).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(80))
    expect(highlight).toHaveBeenCalledTimes(1)
    expect(highlight.mock.calls[0][0]).toBe("abc")
  })
  it("does not display an unmounted or replaced request even if cancellation is ignored", async () => {
    const first = deferred(), second = deferred()
    highlight.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const hook = renderHook(({ code }) => useHighlightedTokens(code, "tsx", true), { initialProps: { code: "old" } })
    hook.rerender({ code: "new" })
    await act(async () => second.resolve([[{ content: "new" }]]))
    await act(async () => first.resolve([[{ content: "stale" }]]))
    expect(hook.result.current?.[0][0].content).toBe("new")
  })
})

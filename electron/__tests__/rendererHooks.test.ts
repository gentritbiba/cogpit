// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { callRendererHook } from "../rendererHooks"

function fakeWindow(executeJavaScript = vi.fn().mockResolvedValue(true)) {
  return { isDestroyed: () => false, webContents: { executeJavaScript } }
}

describe("callRendererHook", () => {
  afterEach(() => vi.useRealTimers())

  it("calls a hook without arguments", async () => {
    const win = fakeWindow()

    await expect(callRendererHook(win as never, "__cogpitOpenKeyboardShortcuts")).resolves.toBe(true)

    const script = win.webContents.executeJavaScript.mock.calls[0][0] as string
    expect(script).toContain('typeof window.__cogpitOpenKeyboardShortcuts === "function"')
    expect(script).toContain("window.__cogpitOpenKeyboardShortcuts()")
  })

  it("gives up after five seconds when the renderer never registers the hook", async () => {
    vi.useFakeTimers()
    const win = fakeWindow(vi.fn().mockResolvedValue(false))

    const result = callRendererHook(win as never, "__cogpitOpenKeyboardShortcuts")
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(result).resolves.toBe(false)
    expect(win.webContents.executeJavaScript).toHaveBeenCalledTimes(20)
  })
})

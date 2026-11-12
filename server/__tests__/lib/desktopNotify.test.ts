// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const mockExecFile = vi.fn()
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}))

import { PassThrough } from "node:stream"
import { showNotification } from "../../lib/desktopNotify"
import { connectDesktopShell, disconnectDesktopShellForTest } from "../../lib/desktopShell"

const NAV = { sessionId: "abc-123", dirName: "-Users-me-proj" }

const realPlatform = process.platform

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true })
}

beforeEach(() => {
  mockExecFile.mockReset()
})

afterEach(() => {
  disconnectDesktopShellForTest()
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true })
})

describe("showNotification inside the desktop app", () => {
  it("hands it to the shell with the path a click reveals, instead of shelling out", () => {
    const output = new PassThrough()
    connectDesktopShell(new PassThrough(), output, { onMessage: vi.fn(), onShutdown: vi.fn() })
    setPlatform("darwin")

    showNotification("Claude Code — proj", "Done", NAV, "h1")

    expect(JSON.parse(output.read().toString())).toEqual({
      type: "notify",
      title: "Claude Code — proj",
      body: "Done",
      nav: NAV,
      historyId: "h1",
      path: "/-Users-me-proj/abc-123",
    })
    // The osascript path is what attributes notifications to Script Editor.
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})

describe("showNotification in the standalone server", () => {
  it("falls back to osascript on macOS", () => {
    setPlatform("darwin")

    showNotification("Cogpit", "Cleaned up 2 leaked processes", NAV)

    expect(mockExecFile).toHaveBeenCalledOnce()
    const [command, args] = mockExecFile.mock.calls[0]
    expect(command).toBe("osascript")
    expect(args[1]).toBe('display notification "Cleaned up 2 leaked processes" with title "Cogpit"')
  })

  it("escapes quotes and backslashes so the AppleScript cannot be broken out of", () => {
    setPlatform("darwin")

    showNotification('say "hi"', 'back\\slash and "quote"', NAV)

    const [, args] = mockExecFile.mock.calls[0]
    expect(args[1]).toBe(
      'display notification "back\\\\slash and \\"quote\\"" with title "say \\"hi\\""',
    )
  })

  it("does nothing on platforms without a fallback", () => {
    setPlatform("linux")

    showNotification("t", "b", NAV)

    expect(mockExecFile).not.toHaveBeenCalled()
  })
})

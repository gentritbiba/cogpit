// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const mockExecFile = vi.fn()
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}))

import { showNotification } from "../../lib/desktopNotify"

const NAV = { sessionId: "abc-123", dirName: "-Users-me-proj" }

interface MutableProcess {
  parentPort?: { postMessage: (message: unknown) => void }
}

const realPlatform = process.platform

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true })
}

beforeEach(() => {
  mockExecFile.mockReset()
})

afterEach(() => {
  delete (process as unknown as MutableProcess).parentPort
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true })
})

describe("showNotification inside Electron", () => {
  it("delegates to the main process instead of shelling out", () => {
    const postMessage = vi.fn()
    ;(process as unknown as MutableProcess).parentPort = { postMessage }
    setPlatform("darwin")

    showNotification("Claude Code — proj", "Done", NAV)

    expect(postMessage).toHaveBeenCalledWith({
      type: "notify",
      title: "Claude Code — proj",
      body: "Done",
      nav: NAV,
    })
    // The osascript path is what attributes notifications to Script Editor.
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it("ignores a parentPort that cannot post", () => {
    ;(process as unknown as MutableProcess).parentPort = {} as { postMessage: () => void }
    setPlatform("darwin")

    showNotification("t", "b", NAV)

    expect(mockExecFile).toHaveBeenCalledOnce()
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

// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

/**
 * Covers the main-process notification path — the code that was 100% dead in
 * production before this work, because the server (a utilityProcess) has no
 * Notification API and silently fell through to osascript.
 */

interface FakeNotification {
  options: { title: string; body: string }
  handlers: Record<string, () => void>
  shown: boolean
}

const created: FakeNotification[] = []
let notificationSupported = true
const dockBounce = vi.fn()
const appFocus = vi.fn()
let allWindows: unknown[] = []
let idleSeconds = 0
const powerHandlers: Record<string, () => void> = {}

vi.mock("electron", () => ({
  app: { dock: { bounce: dockBounce }, focus: appFocus },
  Notification: class {
    static isSupported = () => notificationSupported
    options: { title: string; body: string }
    handlers: Record<string, () => void> = {}
    shown = false
    constructor(options: { title: string; body: string }) {
      this.options = options
      created.push(this as unknown as FakeNotification)
    }
    on(event: string, handler: () => void) { this.handlers[event] = handler; return this }
    show() { this.shown = true }
  },
  BrowserWindow: { getAllWindows: () => allWindows },
  powerMonitor: {
    getSystemIdleTime: () => idleSeconds,
    on: (event: string, handler: () => void) => { powerHandlers[event] = handler },
  },
}))

const { handleWorkerNotification, startAttentionReporting } = await import("../notifications")

const NAV = { dirName: "-Users-me-proj", sessionId: "abc-123" }
const MESSAGE = { type: "notify" as const, title: "Claude Code — proj", body: "Done", nav: NAV }

function fakeWindow(overrides: Record<string, unknown> = {}) {
  return {
    isDestroyed: () => false,
    isFocused: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    flashFrame: vi.fn(),
    once: vi.fn(),
    webContents: { getURL: () => "http://127.0.0.1:19384/", executeJavaScript: vi.fn() },
    ...overrides,
  }
}

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true })
}

beforeEach(() => {
  created.length = 0
  allWindows = []
  notificationSupported = true
  idleSeconds = 0
  dockBounce.mockReset()
  appFocus.mockReset()
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  setPlatform(realPlatform)
  vi.restoreAllMocks()
})

describe("handleWorkerNotification", () => {
  it("shows a notification and bounces the dock", () => {
    handleWorkerNotification(MESSAGE, fakeWindow() as never)
    expect(created).toHaveLength(1)
    expect(created[0].options).toEqual({ title: "Claude Code — proj", body: "Done" })
    expect(created[0].shown).toBe(true)
    expect(dockBounce).toHaveBeenCalled()
  })

  it("ignores messages that are not notifications", () => {
    handleWorkerNotification({ type: "ready", port: 19384 }, fakeWindow() as never)
    handleWorkerNotification({ type: "desktop-attention", attended: true }, fakeWindow() as never)
    expect(created).toHaveLength(0)
  })

  it("suppresses only when focused AND already showing that session", () => {
    const viewing = fakeWindow({
      isFocused: () => true,
      webContents: { getURL: () => "http://127.0.0.1:19384/-Users-me-proj/abc-123", executeJavaScript: vi.fn() },
    })
    handleWorkerNotification(MESSAGE, viewing as never)
    expect(created).toHaveLength(0)
  })

  it("still notifies when focused on a different session", () => {
    const elsewhere = fakeWindow({
      isFocused: () => true,
      webContents: { getURL: () => "http://127.0.0.1:19384/-Users-me-proj/other", executeJavaScript: vi.fn() },
    })
    handleWorkerNotification(MESSAGE, elsewhere as never)
    expect(created).toHaveLength(1)
  })

  it("still notifies when showing that session but blurred", () => {
    const blurred = fakeWindow({
      isFocused: () => false,
      webContents: { getURL: () => "http://127.0.0.1:19384/-Users-me-proj/abc-123", executeJavaScript: vi.fn() },
    })
    handleWorkerNotification(MESSAGE, blurred as never)
    expect(created).toHaveLength(1)
  })

  it("notifies when there is no window at all", () => {
    handleWorkerNotification(MESSAGE, null)
    expect(created).toHaveLength(1)
  })

  it("treats a destroyed window as absent instead of calling into it", () => {
    const destroyed = fakeWindow({
      isDestroyed: () => true,
      isFocused: () => { throw new Error("window is destroyed") },
    })
    expect(() => handleWorkerNotification(MESSAGE, destroyed as never)).not.toThrow()
    expect(created).toHaveLength(1)
  })

  it("does nothing when the OS cannot show notifications", () => {
    notificationSupported = false
    handleWorkerNotification(MESSAGE, fakeWindow() as never)
    expect(created).toHaveLength(0)
  })

  it("never throws out of the main-process handler", () => {
    const hostile = fakeWindow({ isDestroyed: () => { throw new Error("boom") } })
    expect(() => handleWorkerNotification(MESSAGE, hostile as never)).not.toThrow()
  })

  describe("click", () => {
    it("reveals the window and routes the SPA to the session", () => {
      setPlatform("darwin")
      const win = fakeWindow({ isMinimized: () => true, isVisible: () => false })
      handleWorkerNotification(MESSAGE, win as never)
      created[0].handlers.click()

      expect(win.restore).toHaveBeenCalled()
      expect(win.show).toHaveBeenCalled()
      expect(win.focus).toHaveBeenCalled()
      expect(appFocus).toHaveBeenCalledWith({ steal: true })

      const script = (win.webContents.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
      expect(script).toContain('"/-Users-me-proj/abc-123"')
      expect(script).toContain("PopStateEvent('popstate')")
    })

    it("raises the window on Windows instead of stealing the foreground", () => {
      setPlatform("win32")
      const win = fakeWindow({ isMinimized: () => true, isVisible: () => false })
      handleWorkerNotification(MESSAGE, win as never)
      created[0].handlers.click()

      expect(win.restore).toHaveBeenCalled()
      expect(win.show).toHaveBeenCalled()
      expect(win.focus).toHaveBeenCalled()
      expect(appFocus).not.toHaveBeenCalled()
      // Windows can deny the raise, so the taskbar button flashes until focused.
      expect(win.flashFrame).toHaveBeenCalledWith(true)
      expect(win.once).toHaveBeenCalledWith("focus", expect.any(Function))
    })

    it("does not flash the taskbar when Windows granted focus", () => {
      setPlatform("win32")
      const win = fakeWindow({ isFocused: () => true })
      handleWorkerNotification(MESSAGE, win as never)
      created[0].handlers.click()

      expect(win.focus).toHaveBeenCalled()
      expect(win.flashFrame).not.toHaveBeenCalled()
    })

    it("percent-encodes a Codex rollout path into one segment", () => {
      const win = fakeWindow()
      handleWorkerNotification(
        { ...MESSAGE, nav: { dirName: "codex__abc", sessionId: "2026/07/25/rollout-x" } },
        win as never,
      )
      created[0].handlers.click()
      const script = (win.webContents.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
      expect(script).toContain('"/codex__abc/2026%2F07%2F25%2Frollout-x"')
    })

    it("still surfaces the window when there is no session to route to", () => {
      const win = fakeWindow()
      handleWorkerNotification(
        { ...MESSAGE, nav: { dirName: null, sessionId: null } },
        win as never,
      )
      created[0].handlers.click()
      expect(win.focus).toHaveBeenCalled()
      expect(win.webContents.executeJavaScript).not.toHaveBeenCalled()
    })

    it("falls back to any open window if the original is gone", () => {
      const replacement = fakeWindow()
      allWindows = [replacement]
      const original = fakeWindow()
      handleWorkerNotification(MESSAGE, original as never)
      // Window closed between showing the notification and the click.
      original.isDestroyed = () => true
      created[0].handlers.click()
      expect(replacement.focus).toHaveBeenCalled()
    })
  })
})

describe("startAttentionReporting", () => {
  it("reports attended while the user is active", () => {
    const posted: boolean[] = []
    startAttentionReporting(() => fakeWindow() as never, (m) => posted.push(m.attended))
    expect(posted).toEqual([true])
  })

  it("reports unattended once the user goes idle", () => {
    const posted: boolean[] = []
    const report = startAttentionReporting(() => fakeWindow() as never, (m) => posted.push(m.attended))
    idleSeconds = 600
    report()
    expect(posted).toEqual([true, false])
  })

  it("does not repost an unchanged value, so the poll stays quiet", () => {
    const posted: boolean[] = []
    const report = startAttentionReporting(() => fakeWindow() as never, (m) => posted.push(m.attended))
    report()
    report()
    expect(posted).toEqual([true])
  })

  it("reports unattended on lock and attended again on unlock", () => {
    const posted: boolean[] = []
    startAttentionReporting(() => fakeWindow() as never, (m) => posted.push(m.attended))
    powerHandlers["lock-screen"]()
    powerHandlers["unlock-screen"]()
    expect(posted).toEqual([true, false, true])
  })

  it("reports unattended on suspend", () => {
    const posted: boolean[] = []
    startAttentionReporting(() => fakeWindow() as never, (m) => posted.push(m.attended))
    powerHandlers.suspend()
    expect(posted).toEqual([true, false])
  })

  it("reports unattended when the window is gone", () => {
    const posted: boolean[] = []
    startAttentionReporting(() => null, (m) => posted.push(m.attended))
    expect(posted).toEqual([false])
  })
})
